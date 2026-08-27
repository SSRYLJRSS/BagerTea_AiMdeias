//! 共享测试设施：极简同步 HTTP mock 服务器（tests/ 集成测试专用）
//!
//! 选型说明（相对 TEST_STRATEGY §1.3 推荐的 wiremock）：
//! - 被测代码（ai_cloud::request_tags / ollama_setup::pull）均使用 reqwest::blocking，
//!   只需一个可编程的本地 HTTP 端点；wiremock 是 async API，在同步集成测试里需要
//!   自行打理 tokio runtime，得不偿失。
//! - 本 mock 以「请求记录 + 按序/按路径响应」覆盖同样的可编程性：
//!   断言路径/方法/鉴权头/body，构造 5xx/空响应/流式中断/连接拒绝等场景。
//! - 零新 dev-dependency，CI 构建更快。
//!
//! 设计决策（稳定性优先，2026-08-22 实测演化）：
//! 1. 每个连接服务**单个请求**后即关闭（Connection: close + shutdown）：
//!    曾实现 keep-alive 复用（更省连接数），但 Windows 下 reqwest blocking 连接池
//!    复用与本地 mock 之间仍有偶发 send error；单请求即关是表现最稳定的形态。
//! 2. 网络类测试统一持 NET_LOCK 串行执行（CI 里再对网络目标加 --test-threads=1），
//!    彻底消除并发偶发。
//!
//! 用法：
//!   let srv = MockServer::start(|req| match req.path.as_str() {
//!       "/chat/completions" => HttpResponse::ok_json(r#"{"choices":[...]}"#),
//!       _ => HttpResponse::status_only(404),
//!   });
//!   let base = srv.url();          // http://127.0.0.1:<随机端口>
//!   let reqs = srv.requests();     // 已收到请求的记录

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

/// 网络类集成测试的进程级串行锁：
/// 并发跑多个「reqwest blocking ↔ 本地 mock」测试时，Windows 下偶发“error sending
/// request”连接层失败。串行化消除偶发性，换取 CI 确定性。
/// 持锁期间测试可能 panic（断言失败），锁会被 poison —— 用 into_inner 恢复，
/// 避免单测失败连锁毒掉文件内后续所有测试（用 net_lock_guard 获取）。
pub static NET_LOCK: Mutex<()> = Mutex::new(());

pub fn net_lock_guard() -> std::sync::MutexGuard<'static, ()> {
    NET_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// 已录请求（只保留测试关心的字段）
/// 各测试目标读取的字段不同（ai 用 method/headers、ollama 用 path/body），
/// 共享结构在某个目标内必然有未读字段 → 结构级 allow(dead_code)
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct RecordedRequest {
    pub method: String,
    pub path: String,
    pub header_authorization: Option<String>,
    pub header_x_api_key: Option<String>,
    pub body: String,
}

/// 预置响应
#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub content_type: &'static str,
    pub body: String,
}

impl HttpResponse {
    pub fn ok_json(body: &str) -> Self {
        Self {
            status: 200,
            content_type: "application/json",
            body: body.to_string(),
        }
    }

    pub fn status_only(status: u16) -> Self {
        Self {
            status,
            content_type: "text/plain",
            body: String::new(),
        }
    }
}

pub struct MockServer {
    addr: SocketAddr,
    log: Arc<Mutex<Vec<RecordedRequest>>>,
    /// 已 accept 的连接数（含解析失败的连接）；用于定位「请求根本没到/到一半断开」类偶发。
    /// 仅 ai_service_integration 读取；其它测试 target 编译时属 unreachable 字段 → allow
    #[allow(dead_code)]
    accepts: Arc<std::sync::atomic::AtomicUsize>,
    /// 请求头/体读取失败的连接数（连接到了但解析失败）；同上仅 ai 集成测试读取
    #[allow(dead_code)]
    io_failures: Arc<std::sync::atomic::AtomicUsize>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl Drop for MockServer {
    fn drop(&mut self) {
        // 非阻塞 accept 轮询模式下设置停止标志即可让线程退出；阻塞 join 会卡在 incoming()
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(h) = self.handle.take() {
            h.join().ok();
        }
    }
}

impl MockServer {
    /// 启动一个 mock 服务器：每个进来的请求都交给 handler 决定响应；
    /// 并发请求少（网络测试已串行），因此单线程逐连接处理即可
    pub fn start<F>(handler: F) -> Self
    where
        F: Fn(&RecordedRequest) -> HttpResponse + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").expect("mock 端口绑定失败");
        listener
            .set_nonblocking(true)
            .expect("mock listener 设置失败");
        let addr = listener.local_addr().expect("mock 地址读取失败");
        let log: Arc<Mutex<Vec<RecordedRequest>>> = Arc::new(Mutex::new(Vec::new()));
        let log_accept = Arc::clone(&log);
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop2 = Arc::clone(&stop);
        let accepts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let accepts2 = Arc::clone(&accepts);
        let io_failures = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let io_failures2 = Arc::clone(&io_failures);
        let handle = std::thread::spawn(move || {
            loop {
                match listener.accept() {
                    Ok((stream, _)) => {
                        accepts2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        // 连接处理内任何 panic 都不得杀死 accept 循环：
                        // 服务器线程一旦死亡，后续所有请求都会连接失败（“error sending request”），
                        // 这是偶发失败的机制性根源之一
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            if !handle_connection(stream, &handler, &log_accept) {
                                io_failures2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            }
                        }));
                    }
                    Err(_) => {
                        // WouldBlock 或瞬态错误一律容忍继续；stop 后退出
                        if stop2.load(std::sync::atomic::Ordering::SeqCst) {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(5));
                    }
                }
            }
        });
        Self {
            addr,
            log,
            accepts,
            io_failures,
            stop,
            handle: Some(handle),
        }
    }

    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// 返回已接收到请求的日志（按到达顺序）
    pub fn requests(&self) -> Vec<RecordedRequest> {
        self.log.lock().unwrap().clone()
    }

    /// 已 accept 的连接总数（含解析失败者）——与 requests().len() 对比可区分
    /// 「请求未到达」（accepts < 预期）与「到达但 IO 失败」（io_failures > 0）。
    /// 仅 ai_service_integration 使用（其它 target 视为死代码）→ allow
    #[allow(dead_code)]
    pub fn accepts(&self) -> usize {
        self.accepts.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// 读请求头/体失败的连接数；同上仅 ai 集成测试使用
    #[allow(dead_code)]
    pub fn io_failures(&self) -> usize {
        self.io_failures.load(std::sync::atomic::Ordering::SeqCst)
    }
}

/// 单个连接的服务：读一个请求 → 返回一个响应 → 关闭连接。
/// 只服务一个请求（Connection: close + shutdown），避免 keep-alive 复用时序竞态
/// （实测：Windows + reqwest blocking 连接池复用下仍有偶发 send error，单请求即关最稳）。
/// 返回是否成功读到并记录了请求（false = 连接/解析失败，计入 io_failures）
fn handle_connection<F>(
    mut stream: std::net::TcpStream,
    handler: &F,
    log: &Mutex<Vec<RecordedRequest>>,
) -> bool
where
    F: Fn(&RecordedRequest) -> HttpResponse + Send + Sync,
{
    // 读写超时兜底：任何一端挂起 10s 即断开，避免测试永久卡死
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
    // 借用读侧而非 try_clone（try_clone 偶发失败会 panic；且借用不产生新句柄）
    let mut reader = BufReader::new(&mut stream);
    match read_request(&mut reader) {
        Ok(req) => {
            if let Ok(mut l) = log.lock() {
                l.push(req.clone());
            }
            let resp = handler(&req);
            let _ = write_response(&mut stream, &resp);
            // 只关写方向发 FIN；不 drain（drain 会阻塞 accept 循环等待对端 FIN，
            // 拖死后续请求；等待由对端 close 自行收尾）
            let _ = stream.shutdown(std::net::Shutdown::Write);
            true
        }
        Err(_) => {
            // 解析失败：关闭连接（等价于流式中断）
            let _ = stream.shutdown(std::net::Shutdown::Both);
            false
        }
    }
}

fn read_request(
    reader: &mut BufReader<&mut std::net::TcpStream>,
) -> std::io::Result<RecordedRequest> {
    // 请求行：METHOD PATH HTTP/1.1
    let mut req_line = String::new();
    reader.read_line(&mut req_line)?;
    let mut parts = req_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();

    // 头部
    let mut authorization = None;
    let mut x_api_key = None;
    let mut content_length: usize = 0;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            let v = v.trim().to_string();
            match k.trim().to_ascii_lowercase().as_str() {
                "authorization" => authorization = Some(v),
                "x-api-key" => x_api_key = Some(v),
                "content-length" => content_length = v.parse().unwrap_or(0),
                _ => {}
            }
        }
    }

    // body（按 Content-Length 读取精确字节；无长度时给空）
    let mut body = String::new();
    if content_length > 0 {
        let mut buf = vec![0u8; content_length];
        reader.read_exact(&mut buf)?;
        body = String::from_utf8_lossy(&buf).into_owned();
    }

    Ok(RecordedRequest {
        method,
        path,
        header_authorization: authorization,
        header_x_api_key: x_api_key,
        body,
    })
}

fn write_response(stream: &mut std::net::TcpStream, resp: &HttpResponse) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {} X\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        resp.status,
        resp.content_type,
        resp.body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(resp.body.as_bytes())?;
    stream.flush()
}
