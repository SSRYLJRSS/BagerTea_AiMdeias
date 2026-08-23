# 茶包素材 BagerTea V2 代码审查修复裁定书

日期：2026-08-23
前置文档：`full-code-review-report-2026-08-23.md`（两位专家：原报告 + 灵犀复核）
本裁定：逐项核验源码 + 复现实验后的最终决定与修复记录。

---

## 一、总结论

两位专家的分歧项我逐条核验后**采纳灵犀的降级/合并判断**（P1-04 降 P2、P2-05 降 P3、P2-02/P2-11 合并），
并**推翻了报告与灵犀对 P2-08 的共同猜测**：重复 key 警告的根因不是数据竞态，而是
`AssetGrid.tsx` 占位格 `key={c}`（列索引）与素材 `key={asset.id}`（自增整数）在同父级撞 key。

AI 集成测试随机失败**在本环境真实复现**（30 轮循环 + 大 body 探针），失败率 ~5-15%，
根因诊断为 **Windows 本机回环连接的瞬态中止**（`os error 10053 WSAECONNABORTED`、
`connection closed before message completed`；探针显示小 GET 零失败、大 POST ~19% 失败，
服务器侧读写全部成功——与本机安全软件挂钩 socket 的典型症状）。被测状态机行为正确
（连接失败 → 建议正确置 rejected），失败全部来自环境噪声。

## 二、修复清单（13 项已完成）

| 编号 | 定级裁定 | 修复内容 | 验证 |
|---|---|---|---|
| P1-01 | P1 保持 | `libraryStore.ts` 请求代际计数（requestSeq）：refresh/loadMore 响应回写前校验，过期丢弃；refresh 同步去重 | 2 个竞态用例 + 1 个去重用例 |
| P1-02 | P1 保持 | `aiStore.ts` openBatch 写入前校验 `currentBatchId`，A 慢/B 快竞态丢弃 | 1 个竞态用例 |
| P1-03 | P1 保持 | `export_local.rs` 清单导出接入 `unique_dest()`（同名自动 (1)(2)…）+ 临时文件原子重命名 | Rust 单测（不覆盖、无 .tmp 残留） |
| P1-04 | 降 P2（采纳灵犀） | `move_file` 返回源文件清理结果；残留计数写入任务 `warning` 列（v7 迁移），ExportDialog 完成消息附软提示 | 迁移幂等（has_column helper） |
| P2-01 | 不动超时（采纳灵犀），只修 UI 语义 | `aiStore.cancelling` 状态 + AiTaggingPage「取消已受理，当前图片完成后停止」/「已请求取消…」 | 2 个用例 |
| P2-02/P2-11 | 合并（采纳灵犀） | `hooks.ts` subscribe 加 `.catch`；`taskStore.ts` 改 `Promise.allSettled`，部分失败整体回收监听并复位 `subscribed` 允许惰性重试 | 前端测试进程退出码 1 消除 |
| P2-03 | P2 保持 | `SettingsPage.tsx` loadError 分支 + 重试按钮 + 加载失败禁用保存 | 类型检查 |
| P2-04 | **延后**（见第三节） | — | — |
| P2-05 | 降 P3（采纳灵犀） | **延后**（方案需重写，见第三节） | — |
| P2-06 | P2 保持 | `thumbnail_cmd.rs` 拆锁：短锁先清 DB 字段（B27 语义保持），锁外删缓存文件 | cargo check |
| P2-07 | P2 保持（双防线） | 前端 `aiStore` createBatch/createAndRun 按 batchLimit 前置截断并提示；后端 take 保留兜底 | 1 个用例 |
| P2-08 | P2 保持，根因修正 | ① 真根因：AssetGrid 占位格 key 改 `ph-{row}-{col}`；② store 层 refresh 去重防线 | 警告彻底消失，42/42 通过 |
| P2-09 | P2 保持 | `csv_escape` 对 `= + - @` 前缀值前置单引号（AI 标签 = 不可信输入） | Rust 单测（前缀/共存/正常值） |
| P2-10 | P2 保持 | AiTaggingPage switchProfile/changeModel 捕获保存失败并显示 | 类型检查 |
| P3-01 | P3 保持（采纳灵犀轻量方案） | package.json 增加 `test:ignored` npm script（跑 perf_probe/dev_maintenance） | — |
| 静态质量 | 采纳灵犀策略 | lib 12 处 clippy 清零（clamp/let_and_return→has_column 提取/derivable_impls/large_enum_variant 带注释豁免/needless_borrow/is_multiple_of/doc 列表等）；测试文件警告同步清理 | clippy --all-targets 仅剩 perf_probe/ollama 4 个风格警告 |

## 三、延后项与理由（3 项）

1. **P2-04 API Key 明文存储**：建议用 `keyring` crate（Windows Credential Manager 后端，
   灵犀推荐，放弃 Stronghold——依赖体量不匹配）。延后理由：涉及设置读写链路 +
   存量明文密钥迁移 + Windows 凭据交互，属独立专项；本次不仓促引入。
   本文档作为移植依据。
2. **P2-05 预览任意路径读取**：灵犀正确指出「一次性 token 不适用于待入库预览」。
   务实方案：导入会话登记制——前端把本次导入会话文件清单登记给后端（短 TTL），
   `get_preview` 仅允许读清单内路径。延后为独立专项。
3. **300s 单请求超时（P2-01 后端部分）**：认可灵犀判断——不动超时（本地 CPU 7B 慢速
   打标需要），不做「较短分段超时」；请求级可中断需换 async HTTP 客户端，改动面大，
   单独立项。

## 四、测试稳定性结论（AI 集成测试）

- **复现**：本环境 3 轮整包 2 过 1 挂；20-30 轮循环多次失败；探针定量的失败率与
  错误形态见第一节。
- **已做**：mock 增加 accepts/io_failures 诊断计数；全部断言带 `last_error`/请求
  计数上下文（区分"请求未到达/IO 失败"与"状态机真错"）；用例级 `conn_retry_test!`
  外壳——仅当错误含连接层特征（`error sending request`/`connection closed`/`os error 1005x`/
  `error decoding response body`）时整体重建环境重跑（最多 2 次）；业务错误与
  不带连接特征的断言失败不重试。
- **30 轮验证结果**：见底部回归记录。
- 遗留说明：若 CI 机器无此环境病态，本套件零重试通过；诊断计数与上下文断言永久保留。

## 五、回归记录（2026-08-23）

- 前端：类型检查通过；vitest **42/42**（新增 7 个用例），重复 key 警告消除，退出码 0。
- 后端 `cargo test` 全量：单元 67/67、ai_service_integration 11/11、db_integration 20/20、
  format_matrix 6/6、ollama_service_integration 12/12、qa_edge_tests 53/53
  （v7 迁移后 user_version 断言 6→7）、services_integration 9/9；ignored 保持 5 个
  （perf_probe 4 + dev_maintenance 1，见 P3-01 npm script）。
- Clippy：lib 清零；仅剩 perf_probe(2)/ollama_service_integration(2) 测试风格警告（非本次范围）。
- AI 集成稳定性：连接失败复现实验（探针：小 GET 0/150、大 body POST 17/90 → 优雅关闭 13/90 →
  最简形态 12/90；错误链确认 os error 10053）；修复后 **30 轮整包循环 30/30 通过、0 次重试**，
  且每轮均带 accepts/io_failures 诊断计数与 last_error 断言语境（防止假绿）。