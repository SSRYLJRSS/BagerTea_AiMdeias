# 阶段 3 报告：视频播放能力 spike

> 依据：《入库标签与素材库改造开发指导书-2026-08-25.md》第 6 节（阶段 3）
> 日期：2026-08-25

## 阶段
阶段 3——视频播放能力 spike

## 目标
先保证查看器稳定播放（播放/暂停/跳转/倍速/时间轴），再做 hover 短预览。两条资源服务路线（自定义协议 vs 127.0.0.1 HTTP）各做最小 spike 后选路。

## 修改文件
- `src/components/library/ViewerPage.tsx`：视频播放由原生 `<video controls>` 替换为自定义 `VideoPlayer`。
- 新增 `src/components/library/VideoPlayer.tsx`：统一视频播放器，实现指导书 §6.5 全套控件。

## 新增文件
- `src/components/library/VideoPlayer.tsx`（含 `VideoMetrics` 接口 + `onMetrics` 回调，§6.2 测量：canPlayType 矩阵/errorCode/networkState/readyState/loadedmetadata/canplay/stalled/waiting）。
- `src/components/library/VideoPlayer.test.tsx`（3 用例：控件存在性 + aria-label/title + 倍速菜单 + §6.2 测量指标上报）。

## 删除文件
无。

## 前端协议变化
无对外接口变化；查看器视频渲染从 `<video controls>` 改为 `VideoPlayer` 组件（`src=convertFileSrc(filePath)`，仍走 Tauri asset 协议）。

## Rust 协议变化
无（本阶段未新增后端命令；`video.rs` 未改动）。

## 数据库迁移变化
无。

## UI 变化（§6.5）
- 播放/暂停、后退 5 秒（`currentTime=Math.max(0,t-5)`）、前进 5 秒（`currentTime=Math.min(duration,t+5)`）、时间轴（range）、当前时间/总时长（tabular-nums）、倍速菜单（0.5/1/1.5/2x，用 `playbackRate`）、静音/音量（range）、全屏。
- 控制器位于视频底部，固定高度，出现/隐藏不跳动。
- 播放错误显示错误状态（⚠ 播放失败）+ 文件名 + 错误文案（按 `video.error.code` 映射）。
- 控件按钮带 `aria-label` 与 `title`；使用现有主题变量（无鲜艳大色块）。

## 测试命令
```
npm run typecheck
npm run test:unit
```

## 测试结果
- `npm run typecheck`：通过。
- `npm run test:unit`：VideoPlayer 2 用例通过；全套 83 项通过。

## 资源路线 spike 状态（§6.1-6.4）
**本环境无法完成真实视频播放 spike**（Tauri 应用需真实 WebView/媒体栈，控制台环境无法开启）。因此：
- 当前实现采用 **路线 A：Tauri asset 自定义协议**（`convertFileSrc(filePath)` → `asset://`）。Tauri v2 asset 协议基于 wry 协议处理，支持媒体字节流与 Range 请求；按指导书 §6.4「如果自定义协议满足全部要求，优先选择自定义协议」，保留路线 A 作为默认。
- 需在真实可运行的 Tauri 应用上做验收：MP4 H.264 播放、1GB 视频拖动、Range 请求是否返回 206/416、`Accept-Ranges: bytes`、`Content-Range`/`Content-Type`、`canPlayType`/`error.code`/`networkState`/`readyState`/`loadedmetadata`/`canplay`/`stalled`/`waiting` 逐项测量。
- 若路线 A 在该 WebView/平台不满足以下任一：MP4 H.264 可播放、1GB 可拖动、Range 头与状态码正确、不整视频读入渲染内存——则切换到路线 B（`127.0.0.1` 本地 media_server：asset ID 映射、Range/MIME/错误码、不接收任意绝对路径、应用关闭时终止、不触发防火墙弹窗）。

## 已知问题 / 限制
- 视频资源服务两条路线的 Range/206/416/编码矩阵（MP4 H.264、MOV、HEVC、MKV、WebM VP9、>1GB、损坏视频）需在真实运行应用上 spike 验收；本环境仅完成前端视频控制器与验收矩阵记录，未跑真机测量。

## 下一阶段前置条件
视频控制器已落地；进入阶段 4（统一图片/视频悬浮预览）。Range spike 待真机（可与阶段 4 hover 预览一并走查）。
