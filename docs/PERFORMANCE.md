# 茶包素材 V2 — 性能手册

> 版本 v1.0 ｜ 2026-08-12
> 定位：性能实测数据、优化机制原理、回归检查清单。**改任何图像/列表/搜索代码前必读。**

---

## 一、实测基准（真实文件，2026-08）

| 场景 | 优化前 | 优化后 | 倍数 |
|---|---|---|---|
| JPG 320px 缩略图（debug 构建） | 17.9 s | **1.9 ms** | ~9400× |
| RW2（RAW）320px | — | **57 ms** | — |
| RW2 1280px 高清 | — | **81 ms** | — |
| debug 模式全图解码 | 12.7 s | **0.37 s**（dev O3 后） | ~34× |
| jpeg-decoder DCT 缩放（已弃用） | 1.5 s | 慢于 zune-jpeg O3 全解码 → 砍依赖 | — |

> 复测方法：`cd src-tauri && cargo test --test perf_probe -- --ignored --nocapture`

## 二、三大优化机制（原理与依据）

### 2.1 内嵌预览优先（不解码主图）

相机 JPG/RAW 文件内嵌小尺寸预览图（老板实测：JPG 内嵌 160px@32244+2163B、RW2 内嵌 1920×1280@6144+304962B）。直接抠出内嵌 JPEG 字节流给 zune-jpeg 解码，避免解码整张大图。

**实现要点（全部来自真实踩坑）**：

1. **IFD 偏移相对 TIFF 基准而非文件头**——kamadak-exif 不吐基准位置，所以自写 TIFF 遍历（`locate_tiff_base` 处理 JPEG 容器 APP1 定位）
2. RW2 magic 是 `0x55`（标准是 `0x2A`）；Panasonic 用 tag `0x2E` 存 UNDEF 型预览（count 即长度），标准预览走 `0x0201/0x0202`
3. `cut_jpeg` **宽容裁剪**：前 64 字节找 SOI、末尾 `rfind` EOI——某些相机内嵌图尾部有 FF 填充字节，严格校验会误杀
4. **`.jpg` 禁用 FFD8 标记扫描兜底**——会把 7.5MB 主图自己抓回来
5. 策略链兜底顺序：自写 TIFF 遍历 → 标记扫描（RAW only）→ 全图解码

### 2.2 dev 模式 O3 编译

debug 构建默认 opt-level=0，图像解码慢两个数量级。`Cargo.toml`：

```toml
[profile.dev.package.image]
opt-level = 3
[profile.dev.package.zune-jpeg]
opt-level = 3
[profile.dev.package.png]
opt-level = 3
[profile.dev.package.kamadak-exif]
opt-level = 3
[profile.dev.package.rayon]
opt-level = 3
```

**新增图像/编码类依赖必须同步加入此列表**，否则 dev 下性能回归。

### 2.3 并发与锁

- **4 许可信号量**（`Mutex<usize>` + `Condvar`，RAII guard）：限制并发解码数，防内存爆炸与调度抖动
- **DB 锁短暂持有**：`get_or_create_hd` 曾在大图解码期间持 DB 锁，饿死全部请求（大图加载不出的病根）——解码放锁外，只短暂持锁查/写路径

## 三、前端性能策略

| 场景 | 策略 |
|---|---|
| 素材网格 | @tanstack/react-virtual 虚拟滚动；双层缩略图淡入替换（占位图→高清图） |
| 待入库清单 | 列表模式纯文字（不渲染缩略图）；缩略图模式 LazyThumb 懒加载；固定 36px 头部 |
| 预览接口 | `api/preview.ts` 模块级缓存，重复路径不重复 invoke |
| 搜索 | 输入防抖；后端 FTS5 三策略（逐字切分/短语/≤2 字 LIKE） |
| 查看器 | 高清 1920 优先 + 原图兑底；缩放/平移纯 transform（不触发重排） |

## 四、性能回归检查清单（M1 出口 / 大改后必做）

- [ ] `perf_probe` 探针跑真实文件：JPG 320px ≤ 5ms、RW2 320px ≤ 100ms
- [ ] 3 万素材数据集：网格滚动无白块卡顿、搜索响应 < 300ms
- [ ] 入库 100 图：每张立即有占位图，页面不卡死
- [ ] 打标批次 17+ 张：进度条持续推进，UI 可交互（网络在 spawn_blocking）
- [ ] dev 模式新增依赖后：O3 列表已更新

## 五、常见性能反模式（看到就改）

1. 在 DB 锁内做 IO/解码/网络
2. React state 存大数组每帧重建（用虚拟滚动 + memo）
3. 为"快"引入第二个解码路径（必须收编进 imaging.rs）
4. 缩略图同步串行等待（走信号量并发 + 缓存命中）
5. debug 模式下用未加 O3 的新解码库测性能然后误判方案不行（jpeg-decoder 的教训：先确认测量环境再下结论）
