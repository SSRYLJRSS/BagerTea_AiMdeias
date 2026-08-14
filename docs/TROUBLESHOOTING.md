# 茶包素材 V2 — 踩坑与疑难手册

> 版本 v1.0 ｜ 2026-08-12
> 定位：**真实踩过的坑全记录**——症状、根因、修法。遇到"看不懂的防御性代码"先来这查；新踩的坑修完必须追加。

---

## 一、后端 / Rust

### 1. 大图加载不出（打标页占位框不动）

- **根因**：`get_or_create_hd` 解码大图期间持 DB 锁 → 饿死全部其他请求
- **修法**：改 `Arc<Mutex>` 短暂持锁，解码放锁外
- **教训**：DB 锁内禁止耗时操作

### 2. 缩略图极慢（17.9s/张）三真凶

| 真凶 | 修法 |
|---|---|
| JPEG 内嵌预览的 IFD 偏移**相对 TIFF 基准而非文件头**（kamadak 不吐基准） | 自写 TIFF 遍历 `locate_tiff_base`（APP1 定位） |
| debug 构建全图解码 12.7s | `[profile.dev.package.*] opt-level = 3` |
| 串行解码 | 4 许可信号量并发 |

### 3. cut_jpeg 误杀内嵌图

- **根因**：严格 SOI/EOI 校验——老板相机内嵌图尾部有 FF 填充字节
- **修法**：前 64 字节找 SOI、末尾 `rfind` EOI（piexif 对照验证过）

### 4. marker_scan 抓回 7.5MB 主图

- **根因**：对 `.jpg` 做 FFD8 标记扫描会命中主图自己
- **修法**：`.jpg` 禁用标记扫描兜底

### 5. jpeg-decoder "优化"反而更慢

- **实测**：DCT 缩放 1.5s 慢于 zune-jpeg O3 全解码 0.37s
- **修法**：砍依赖。**教训：先在正确编译优化级别下测量，再决定方案**

### 6. 打标没结果（v2.12 修复，最重要状态机坑）

- **症状**：按「开始打标」没反应
- **根因 A**：`ai_start_batch` 对 `done` 状态直接报错 →「仅打标前 N 张」后剩余 pending 永远无法续跑，前端错误只有一行小字
- **根因 B**：模型返回不可解析内容 → 空 map 被当成功写入 `{}`（mimo-v2.5 经中转站，疑似不支持视觉）
- **修法**：done/cancelled 可续跑 pending（仅 processing 拒绝）；`parse_tags_strict` 空解析即 Err 走单条失败
- **排查手法**：直接查 DB 现场（批次状态/processed/建议 tags 值），别猜

### 7. 配置"丢失"假象

- **症状**：`SELECT … WHERE key='settings'` 查不到
- **真相**：settings 表 key 是 **`app_settings`**，JSON 整体存取

### 8. settings_roundtrip 测试断言失败

- **根因**：AI 配置改多档案结构（profiles[]）后测试还断言旧扁平字段
- **修法**：迁移 `normalize()` 只读旧字段（skip_serializing），测试改档案结构断言。**教训：结构迁移必同步测试**

## 二、前端 / React

### 9. 右键菜单项全部失效（"你不会只做了 ui 吧"）

- **根因**：ContextMenu 点外关闭用**捕获阶段**监听，把菜单项自己的点击也拦了
- **修法**：捕获回调里 `if (ref.current?.contains(e.target)) return` 排除菜单内部

### 10. Alt+滚轮缩放拦不住页面滚动

- **根因**：React `onWheel` 是 passive 监听，preventDefault 无效
- **修法**：原生 `addEventListener('wheel', fn, { passive: false })`

### 11. aiCreateBatch 参数顺序传反

- **症状**：建批失败/模式错乱
- **修法**：`(ids, mode)` 顺序，tsc 抓获。**教训：invoke 封装函数签名改参数顺序后全仓搜索调用点**

### 12. 缩放锚点漂移

- **公式**：`imgP = (cursor - center - pan) / scale; pan' = cursor - center - imgP * nextScale`
- 查看器缩放/平移必须以光标为锚，改这块先用大图验证手感

## 三、工具链 / 环境

### 13. `npm : 无法将"npm"项识别为…`

- **根因**：便携 Node 不在系统 PATH
- **修法**：见 DEVELOPMENT.md 第一节；VSCode 终端需重启或配置 profile

### 14. bash 里 cargo 找不到

- **修法**：`export PATH="/c/Users/33887/.cargo/bin:$PATH"`（每个新 shell 都要）

### 15. python sqlite3 清数据报 `no such function: cjk_bigram`

- **根因**：FTS 触发器依赖应用启动时注册的自定义分词函数，外部连接没有
- **修法**：**外部连接只能 SELECT**；清数据用应用内删除功能

### 16. CRLF 行尾导致补丁工具匹配失败 / bash heredoc 断裂

- **修法**：复杂补丁写 python .py 文件执行（读文件归一 `\r\n`→`\n` 处理，写回恢复）；禁止 heredoc 传含特殊字符的长文本

### 17. tauri dev 日志丢失 / 后端没重编译

- **现象**：/tmp 日志电脑重启后丢失；vite 1420 活着但 exe 是旧的
- **修法**：确认 cargo watcher 进程在跑；拿不准就重启 `npm run tauri dev`

## 四、排查方法论（新 bug 来了怎么做）

1. **先取证后动手**：DB 现场（批次/建议/settings 实际值）、日志、网络响应——三类现场先固定
2. **状态机问题画出来**：把状态流转写在纸上，找"哪个转移被谁挡住"（打标 bug 就是这么破的）
3. **性能问题先查编译优化级别**，再查算法
4. **"没反应"类 bug 先找被吞的错误**：前端 catch 后只 set error 小字、后端 Err 被 `?` 静默传递，都是高发区
5. 修复必须配回归测试（解析类纯函数最好测）
