/** W4 分面管理面板（整体重写）：两组列表 + 弹窗化编辑/新建/删除。
 *  - 两组列表：「AI 自动打标的分类」/「只手工填写的分类」+ 底部折叠「已停用的分类」（Q2：系统分面不可删，停用的折叠只给恢复）
 *  - 拖拽手柄跨组拖动 = 改 input_mode；组内拖动 = reorder
 *  - 列表行只显示 4 项：名称 / key（小字）/ 规则摘要 / 操作按钮；详情进弹窗
 *  - 编辑弹窗 6 字段一个保存通道（update_tag_facet 单事务；替代旧的「基本规则即时写 + AI 行为进草稿」双通道）
 *  - 新建弹窗 2 个必填（名称 + 这类标签是什么）；key 自动 slugify，CJK 生成空串时明确提示
 *  - 删除确认弹窗：精确影响数字 + 输入分类名确认 + 三按钮（取消 / 停用替代 / 确认删除）
 *  - 「一句话描述（AI 生成）」：与分面条目同形态的可点开条目——点开看已有描述，
 *    里面提供打标/搜索提示词编辑（draft 草稿，页面「保存设置」统一落库；空 = 用内置默认）
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import Button from "@/components/common/Button";
import Modal from "@/components/common/Modal";
import TagManageDialog from "@/components/dialogs/TagManageDialog";
import {
  createTagFacet,
  deactivateTagFacet,
  deleteTagFacet,
  getTagFacetImpact,
  listAllTagFacets,
  listContentDescriptions,
  reorderTagFacets,
  restoreTagFacet,
  updateTagFacet,
  type FacetDeleteReport,
  type ContentDescription,
} from "@/api/tags";
import type { TagFacet, TagFacetImpact } from "@/types/tag";
import type { Settings } from "@/types/settings";

const APP_TO_OPTIONS: { value: "all" | "image" | "video"; label: string }[] = [
  { value: "all", label: "全部素材" },
  { value: "image", label: "只图片" },
  { value: "video", label: "只视频" },
];

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^[0-9]+/, "")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

function ruleSummary(f: TagFacet): string {
  const mode = f.selectionMode === "single" ? "单选" : f.maxItems ? `可多选 ≤${f.maxItems}` : "可多选不限";
  const applies = APP_TO_OPTIONS.find((o) => o.value === f.appliesTo)?.label ?? "全部";
  return f.appliesTo === "all" ? mode : `${mode} · ${applies}`;
}

export default function FacetManagePanel({ draft, onPatchAi }: {
  draft: Settings;
  onPatchAi: (patch: Partial<Settings["ai"]>) => void;
}) {
  const [facets, setFacets] = useState<TagFacet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  /** W4 弹窗状态：编辑 / 新建（默认落哪组）/ 删除 / 分类词条 */
  const [editing, setEditing] = useState<TagFacet | null>(null);
  const [creatingGroup, setCreatingGroup] = useState<"ai" | "manual" | null>(null);
  const [deleting, setDeleting] = useState<TagFacet | null>(null);
  const [deleteImpact, setDeleteImpact] = useState<TagFacetImpact | null>(null);
  const [deleteReport, setDeleteReport] = useState<FacetDeleteReport | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState("");
  const [termsFacet, setTermsFacet] = useState<TagFacet | null>(null);
  /** 拖拽中：跨组 = 改 input_mode；组内 = reorder */
  const [dragKey, setDragKey] = useState<string | null>(null);
  /** 一句话描述：可点开条目（像分面条目一样点开看内容），展开态 */
  const [descOpen, setDescOpen] = useState(false);
  /** 提示词编辑区是否已展开（与描述列表同在一个展开条目内） */
  const [promptOpen, setPromptOpen] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setFacets(await listAllTagFacets());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  /** 一句话描述展示（AI 生成，走 FTS 模糊搜索；失败静默降级不阻塞面板） */
  const [descriptions, setDescriptions] = useState<ContentDescription[]>([]);
  const [descLoading, setDescLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    listContentDescriptions(200)
      .then((d) => {
        if (!cancelled) setDescriptions(d);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setDescLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (fn: () => Promise<unknown>, okMsg?: string) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      await refresh();
      if (okMsg) setNotice(okMsg);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // custom（AI 未知分类的兜底桶，resolve_facet_key 分支③）与 color（V16 起由算法主色
  // 替代，属机器可读属性，色条 + 文件属性面板承担展示）不在分面管理 UI 展示——界面干净，
  // 后端兜底链路不受影响（隐藏 ≠ 删除）。
  const visibleFacets = useMemo(() => facets.filter((f) => f.key !== "custom" && f.key !== "color"), [facets]);
  const active = useMemo(() => visibleFacets.filter((f) => f.status === "active"), [visibleFacets]);
  const aiGroup = useMemo(() => active.filter((f) => f.inputMode === "ai_and_manual"), [active]);
  const manualGroup = useMemo(() => active.filter((f) => f.inputMode === "manual_only"), [active]);
  const inactive = useMemo(() => visibleFacets.filter((f) => f.status !== "active"), [visibleFacets]);

  /** 跨组拖动 = 改 input_mode（走 update_tag_facet 单事务） */
  const moveToGroup = (facet: TagFacet, group: "ai" | "manual") => {
    const nextMode = group === "ai" ? "ai_and_manual" : "manual_only";
    if (facet.inputMode === nextMode) return;
    void run(
      () => updateTagFacet({
        key: facet.key,
        displayName: facet.displayName,
        description: facet.description,
        inputMode: nextMode,
        selectionMode: facet.selectionMode,
        maxItems: facet.maxItems,
        appliesTo: facet.appliesTo,
      }),
      `「${facet.displayName}」已移到${group === "ai" ? " AI 自动打标" : "只手工填写"}组`,
    );
  };

  /** 组内拖动 = reorder（本组按新序插入，其它组保持不变） */
  const reorderInGroup = async (draggedKey: string, targetKey: string, groupKeys: string[]) => {
    if (draggedKey === targetKey) return;
    const keys = [...groupKeys];
    const from = keys.indexOf(draggedKey);
    const to = keys.indexOf(targetKey);
    if (from < 0 || to < 0) return;
    keys.splice(to, 0, keys.splice(from, 1)[0]);
    // 全量顺序：遍历原 facets，遇到本组第一个成员时替换为整组新序
    const merged: string[] = [];
    let inserted = false;
    for (const f of facets) {
      if (keys.includes(f.key)) {
        if (!inserted) {
          merged.push(...keys);
          inserted = true;
        }
      } else {
        merged.push(f.key);
      }
    }
    await run(() => reorderTagFacets(merged));
  };

  const onDropToGroup = (group: "ai" | "manual", targetKey?: string) => {
    if (!dragKey) return;
    const facet = facets.find((f) => f.key === dragKey);
    setDragKey(null);
    if (!facet || facet.status !== "active") return;
    const groupList = group === "ai" ? aiGroup : manualGroup;
    if (targetKey && groupList.some((f) => f.key === dragKey)) {
      void reorderInGroup(dragKey, targetKey, groupList.map((f) => f.key));
    } else {
      moveToGroup(facet, group);
    }
  };

  /** 打开删除确认：先取精确影响数字 */
  const openDelete = async (facet: TagFacet) => {
    setDeleting(facet);
    setDeleteConfirmName("");
    setDeleteReport(null);
    try {
      setDeleteImpact(await getTagFacetImpact(facet.key));
    } catch {
      setDeleteImpact(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      const report = await deleteTagFacet(deleting.key);
      setDeleteReport(report);
      setDeleting(null);
      await refresh();
      setNotice(`已删除「${facetName(deleting)}」`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const facetName = (f: TagFacet) => f.displayName;

  const renderRow = (f: TagFacet, group: "ai" | "manual") => (
    <li
      key={f.key}
      draggable
      onDragStart={() => setDragKey(f.key)}
      onDragEnd={() => setDragKey(null)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={() => onDropToGroup(group, f.key)}
      className={clsx(
        "flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5",
        dragKey === f.key && "opacity-50",
      )}
    >
      <span className="cursor-grab select-none text-[var(--color-text-tertiary)]" title="拖动排序；拖到另一组 = 改归类">⠿</span>
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--color-text)]" title={f.description}>{f.displayName}</span>
      <span className="shrink-0 rounded bg-[var(--color-surface-hover)] px-1 text-[10px] text-[var(--color-text-secondary)]" title={f.key}>{f.key}</span>
      {f.isSystem && <span className="shrink-0 rounded bg-[var(--color-surface-hover)] px-1 text-[10px] text-[var(--color-text-secondary)]">系统</span>}
      <span className="shrink-0 text-[10px] text-[var(--color-text-tertiary)]">{ruleSummary(f)}</span>
      <span className="flex shrink-0 items-center gap-1">
        <button type="button" onClick={() => setEditing(f)} className="rounded px-1.5 py-0.5 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]">编辑</button>
        <button type="button" onClick={() => setTermsFacet(f)} className="rounded px-1.5 py-0.5 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]">词条</button>
        {!f.isSystem && (
          <button type="button" onClick={() => void openDelete(f)} className="rounded px-1.5 py-0.5 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-danger)]">删除</button>
        )}
      </span>
    </li>
  );

  const renderGroup = (title: string, hint: string, group: "ai" | "manual", list: TagFacet[]) => (
    <section
      onDragOver={(e) => e.preventDefault()}
      onDrop={() => onDropToGroup(group)}
      className="flex flex-col gap-1.5"
    >
      <div className="flex items-center justify-between">
        <div>
          <h5 className="text-[11px] font-semibold text-[var(--color-text)]">{title}</h5>
          <p className="text-[10px] text-[var(--color-text-tertiary)]">{hint}</p>
        </div>
        <Button onClick={() => setCreatingGroup(group)}>+ 新增分类</Button>
      </div>
      <ul className="flex flex-col gap-1.5">
        {list.map((f) => renderRow(f, group))}
        {list.length === 0 && (
          <li className="rounded-md border border-dashed border-[var(--color-border)] px-2 py-3 text-center text-[11px] text-[var(--color-text-tertiary)]">
            拖分类到这里，或点上方「+ 新增分类」
          </li>
        )}
      </ul>
    </section>
  );

  return (
    <div className="flex flex-col gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <h4 className="text-xs font-medium text-[var(--color-text)]">分类大类（分面）</h4>
      <p className="text-[11px] leading-4 text-[var(--color-text-secondary)]">
        拖动分类跨组 = 改归类（AI 自动打标 ↔ 只手工填写）；组内拖动 = 调整顺序。创建后英文标识锁定不可改。
      </p>

      {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}
      {notice && <p className="text-xs text-[var(--color-text-secondary)]">{notice}</p>}

      {loading ? (
        <p className="text-xs text-[var(--color-text-secondary)]">加载分类…</p>
      ) : (
        <>
          {renderGroup("AI 自动打标的分类", "AI 打标会产出这些分类的标签；也可手工填写", "ai", aiGroup)}
          {renderGroup("只手工填写的分类", "AI 不会产出；只出现在打标工作台「需要你填」组", "manual", manualGroup)}

          {/* Q2：已停用分面折叠区（系统分面不可删，只给恢复） */}
          {inactive.length > 0 && (
            <section className="mt-1">
              <button
                type="button"
                onClick={() => setShowInactive((v) => !v)}
                className="flex items-center gap-1 text-[11px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
              >
                已停用的分类（{inactive.length}）{showInactive ? "▾" : "▸"}
              </button>
              {showInactive && (
                <ul className="mt-1.5 flex flex-col gap-1.5">
                  {inactive.map((f) => (
                    <li key={f.key} className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 opacity-75">
                      <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-secondary)] line-through">{f.displayName}</span>
                      <span className="shrink-0 rounded bg-[var(--color-surface-hover)] px-1 text-[10px] text-[var(--color-text-secondary)]">{f.key}</span>
                      <span className="shrink-0 text-[10px] text-[var(--color-text-tertiary)]">{ruleSummary(f)}</span>
                      <button type="button" onClick={() => run(() => restoreTagFacet(f.key), `已恢复「${f.displayName}」`)} className="rounded px-1.5 py-0.5 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]">恢复</button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {/* 一句话描述（AI 生成）：与分面同形态的可点开条目——点开看具体描述，
              里面提供打标/搜索提示词编辑（进 draft，「保存设置」统一落库；空 = 内置默认） */}
          <section className="mt-1">
            <button
              type="button"
              onClick={() => setDescOpen((v) => !v)}
              className="flex w-full items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-left"
            >
              <span className="text-[var(--color-text-tertiary)]">{descOpen ? "▾" : "▸"}</span>
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--color-text)]">一句话描述（AI 生成）</span>
              {!descLoading && <span className="shrink-0 rounded bg-[var(--color-surface-hover)] px-1 text-[10px] text-[var(--color-text-secondary)]">{descriptions.length} 条</span>}
              {draft.ai.systemPromptTagging.trim() && <span className="shrink-0 rounded bg-[var(--color-surface-hover)] px-1 text-[10px] text-[var(--color-text-secondary)]">已改提示词</span>}
            </button>
            {descOpen && (
              <div className="mt-1.5 flex flex-col gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
                <p className="text-[11px] leading-4 text-[var(--color-text-secondary)]">
                  打标时 AI 顺带生成的整句描述，属于自由文本不进分面（分面=精确筛选）；已加入全文索引，超级搜索可直接模糊搜到（如「夜晚树下多人」）。
                </p>
                {descLoading ? (
                  <p className="text-[11px] text-[var(--color-text-tertiary)]">加载描述…</p>
                ) : descriptions.length === 0 ? (
                  <p className="text-[11px] text-[var(--color-text-tertiary)]">
                    还没有一句话描述。AI 打标确认时会自动生成；生成后这里可查看、超级搜索可搜到。
                  </p>
                ) : (
                  <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
                    {descriptions.map((d) => (
                      <li key={d.assetId} className="flex items-baseline gap-2 rounded bg-[var(--color-surface)] px-2 py-1">
                        <span className="max-w-28 shrink-0 truncate text-[10px] text-[var(--color-text-tertiary)]" title={d.fileName}>
                          {d.fileName}
                        </span>
                        <span className="min-w-0 flex-1 text-[11px] leading-4 text-[var(--color-text-secondary)]" title={d.description}>
                          {d.description}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                {/* 提示词编辑：点开条目内部；空 = 用内置默认提示词 */}
                <div className="border-t border-[var(--color-border)] pt-2">
                  <button
                    type="button"
                    onClick={() => setPromptOpen((v) => !v)}
                    className="flex items-center gap-1 text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
                  >
                    {promptOpen ? "▾" : "▸"} 提示词（可选，自行修改）
                  </button>
                  {promptOpen && (
                    <div className="mt-1.5 flex flex-col gap-2">
                      <label className="flex flex-col gap-1 text-[11px]">
                        <span className="text-[var(--color-text-secondary)]">AI 打标提示词（控制标签与一句话描述的生成）</span>
                        <textarea
                          className="ui-control min-h-28 w-full px-2 py-1.5 text-xs"
                          value={draft.ai.systemPromptTagging}
                          onChange={(e) => onPatchAi({ systemPromptTagging: e.target.value })}
                          placeholder="留空 = 使用内置默认提示词"
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-[11px]">
                        <span className="text-[var(--color-text-secondary)]">超级搜索提示词（控制 AI 识别搜索意图）</span>
                        <textarea
                          className="ui-control min-h-28 w-full px-2 py-1.5 text-xs"
                          value={draft.ai.systemPromptSearch}
                          onChange={(e) => onPatchAi({ systemPromptSearch: e.target.value })}
                          placeholder="留空 = 使用内置默认提示词"
                        />
                      </label>
                      <p className="text-[10px] leading-3 text-[var(--color-text-tertiary)]">
                        改动先进入草稿，点右上角「保存设置」才生效；清空恢复内置默认。
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>
        </>
      )}

      {/* W4-2 编辑弹窗（6 字段一个保存通道） */}
      <EditFacetDialog
        facet={editing}
        onClose={() => setEditing(null)}
        onSaved={(msg) => { setNotice(msg); void refresh(); }}
        onError={setError}
      />

      {/* W4-3 新建弹窗（2 个必填；默认落点组） */}
      <CreateFacetDialog
        group={creatingGroup}
        onClose={() => setCreatingGroup(null)}
        onCreated={(msg) => { setNotice(msg); setCreatingGroup(null); void refresh(); }}
      />

      {/* W4-4 删除确认弹窗 */}
      <Modal
        open={deleting != null}
        title={deleting ? `删除分类「${deleting.displayName}」` : "删除分类"}
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>取消</Button>
            {deleting && (
              <Button
                onClick={() => { const f = deleting; setDeleting(null); void run(() => deactivateTagFacet(f.key), `已停用「${f.displayName}」（历史标签保留）`); }}
              >
                停用替代
              </Button>
            )}
            <Button
              variant="danger"
              disabled={!deleting || deleteConfirmName.trim() !== deleting.displayName}
              onClick={() => void confirmDelete()}
            >
              确认删除
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 text-sm">
          <p className="text-[var(--color-danger)]">此操作不可恢复。素材文件本身不会被删除。</p>
          {deleteImpact && (
            <ul className="rounded-md bg-[var(--color-surface)] p-2 text-xs text-[var(--color-text-secondary)]">
              <li>将删除 {deleteImpact.tagCount} 个标签</li>
              <li>解除 {deleteImpact.assetCount} 个素材的关联</li>
              <li>清除 {deleteImpact.aiSuggestionItemCount} 条 AI 候选记录、{deleteImpact.tagOpCount} 条操作流水</li>
              {deleteImpact.aliasCount > 0 && <li>删除 {deleteImpact.aliasCount} 条别名</li>}
            </ul>
          )}
          <p className="text-xs text-[var(--color-text-secondary)]">建议改用「停用」：历史标签与查询保留，随时可恢复。</p>
          {deleting && (
            <label className="flex flex-col gap-1 text-xs">
              输入分类名「{deleting.displayName}」确认：
              <input className="ui-control px-2 py-1 text-sm" value={deleteConfirmName} onChange={(e) => setDeleteConfirmName(e.target.value)} placeholder={deleting.displayName} />
            </label>
          )}
          {deleteReport && (
            <p className="text-xs text-[var(--color-success)]">
              已删除：{deleteReport.tagsDeleted} 个标签、{deleteReport.unlinked} 条素材关联。
            </p>
          )}
        </div>
      </Modal>

      {/* 分类词条二级编辑器（保留） */}
      <TagManageDialog
        open={termsFacet != null}
        onClose={() => setTermsFacet(null)}
        title={termsFacet ? `分类词条：${termsFacet.displayName}` : "分类词条"}
      />
    </div>
  );
}

/** W4-2 编辑弹窗：6 字段一个保存按钮一个事务（update_tag_facet） */
function EditFacetDialog({ facet, onClose, onSaved, onError }: {
  facet: TagFacet | null;
  onClose: () => void;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [inputMode, setInputMode] = useState<"ai_and_manual" | "manual_only">("ai_and_manual");
  const [selectionMode, setSelectionMode] = useState<"single" | "multi">("multi");
  const [maxItems, setMaxItems] = useState("");
  const [appliesTo, setAppliesTo] = useState<"all" | "image" | "video">("all");
  const [saving, setSaving] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    if (facet) {
      setDisplayName(facet.displayName);
      setDescription(facet.description);
      setInputMode(facet.inputMode);
      setSelectionMode(facet.selectionMode);
      setMaxItems(facet.maxItems ? String(facet.maxItems) : "");
      setAppliesTo(facet.appliesTo);
      setShowAdvanced(false);
    }
  }, [facet]);

  const submit = async () => {
    if (!facet) return;
    setSaving(true);
    try {
      await updateTagFacet({
        key: facet.key,
        displayName: displayName.trim(),
        description,
        inputMode,
        selectionMode,
        maxItems: selectionMode === "single" ? 1 : maxItems ? Number(maxItems) || null : null,
        appliesTo,
      });
      onSaved(`已保存「${displayName.trim()}」`);
      onClose();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={facet != null}
      title={facet ? `编辑分类：${facet.displayName}` : "编辑分类"}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={saving || !displayName.trim()} onClick={() => void submit()}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </>
      }
    >
      {facet && (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs">
            分类名称
            <input className="ui-control px-2 py-1.5 text-sm" value={displayName} onChange={(e) => setDisplayName(e.target.value)} aria-label="分类名称" />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            这类标签是什么
            <textarea
              className="ui-control min-h-20 px-2 py-1.5 text-sm"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              aria-label="这类标签是什么"
              placeholder="如「人物服装的主色调」（这段话会原样给 AI 看，写得越具体标得越准）"
            />
            <span className="text-[10px] text-[var(--color-text-tertiary)]">这段话会原样给 AI 看，写得越具体标得越准</span>
          </label>
          <fieldset className="flex flex-col gap-1 text-xs">
            <legend className="mb-0.5">归类</legend>
            <label className="flex items-center gap-1.5"><input type="radio" checked={inputMode === "ai_and_manual"} onChange={() => setInputMode("ai_and_manual")} />AI 自动打标（也可手工填写）</label>
            <label className="flex items-center gap-1.5"><input type="radio" checked={inputMode === "manual_only"} onChange={() => setInputMode("manual_only")} />只手工填写</label>
          </fieldset>
          <fieldset className="flex flex-col gap-1 text-xs">
            <legend className="mb-0.5">可选几个</legend>
            <label className="flex items-center gap-1.5"><input type="radio" checked={selectionMode === "single"} onChange={() => setSelectionMode("single")} />只能选 1 个</label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={selectionMode === "multi"} onChange={() => setSelectionMode("multi")} />可多选，上限
              <input className="ui-control w-16 px-1 py-0.5" type="number" min={1} disabled={selectionMode === "single"} value={maxItems} onChange={(e) => setMaxItems(e.target.value)} placeholder="不限" aria-label="多选上限" />
              （留空 = 不限）
            </label>
          </fieldset>
          <div>
            <button type="button" onClick={() => setShowAdvanced((v) => !v)} className="text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]">
              ▸ 高级{showAdvanced ? "（收起）" : ""}
            </button>
            {showAdvanced && (
              <div className="mt-2 flex flex-col gap-2">
                <label className="flex items-center gap-2 text-xs">
                  适用于
                  <select className="ui-control rounded px-1 py-0.5 text-xs" value={appliesTo} onChange={(e) => setAppliesTo(e.target.value as typeof appliesTo)} aria-label="适用于">
                    {APP_TO_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </label>
                <label className="flex items-center gap-2 text-xs text-[var(--color-text-tertiary)]">
                  英文标识（只读）：<code>{facet.key}</code>
                </label>
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

/** W4-3 新建弹窗：2 个必填（名称 + 这类标签是什么）；key 自动生成，CJK 空串时明确提示 */
function CreateFacetDialog({ group, onClose, onCreated }: {
  group: "ai" | "manual" | null;
  onClose: () => void;
  onCreated: (msg: string) => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [key, setKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (group != null) {
      setDisplayName("");
      setKey("");
      setKeyTouched(false);
      setDescription("");
      setErr(null);
    }
  }, [group]);

  const effectiveKey = keyTouched ? key : slugify(displayName);
  const keyEmpty = effectiveKey.trim() === "";

  const submit = async () => {
    setErr(null);
    if (!displayName.trim()) return setErr("请填写分类名称");
    if (!description.trim()) return setErr("请填写「这类标签是什么」（它会成为给 AI 的提示词）");
    if (keyEmpty) return setErr("请填写英文标识（中文名无法自动生成）");
    setSaving(true);
    try {
      await createTagFacet({
        key: effectiveKey,
        displayName: displayName.trim(),
        description: description.trim(),
        selectionMode: "multi",
        maxItems: null,
        appliesTo: "all",
      });
      // 新建默认 ai_and_manual；「只手工填写」组的按钮需要再改一次 input_mode
      if (group === "manual") {
        await updateTagFacet({
          key: effectiveKey,
          displayName: displayName.trim(),
          description: description.trim(),
          inputMode: "manual_only",
          selectionMode: "multi",
          maxItems: null,
          appliesTo: "all",
        });
      }
      onCreated(`已创建「${displayName.trim()}」`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={group != null}
      title={`新增分类${group === "ai" ? "（AI 自动打标）" : group === "manual" ? "（只手工填写）" : ""}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={saving} onClick={() => void submit()}>{saving ? "创建中…" : "创建"}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-xs">
          分类名称（必填）
          <input className="ui-control px-2 py-1.5 text-sm" placeholder="如「人物服装颜色」" value={displayName} onChange={(e) => setDisplayName(e.target.value)} aria-label="分类名称" />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          这类标签是什么（必填）
          <textarea className="ui-control min-h-20 px-2 py-1.5 text-sm" placeholder="如「人物服装的主色调」（这段话会原样给 AI 看）" value={description} onChange={(e) => setDescription(e.target.value)} aria-label="这类标签是什么" />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          英文标识
          <input
            className="ui-control px-2 py-1.5 text-sm"
            placeholder={keyEmpty ? "请输入英文标识，如 clothing_color" : effectiveKey}
            value={effectiveKey}
            onChange={(e) => { setKey(slugify(e.target.value)); setKeyTouched(true); }}
            aria-label="英文标识"
          />
          <span className="text-[10px] text-[var(--color-text-tertiary)]">⚠ 创建后不可修改，只能删除</span>
        </label>
        {err && <p className="text-xs text-[var(--color-danger)]">{err}</p>}
      </div>
    </Modal>
  );
}
