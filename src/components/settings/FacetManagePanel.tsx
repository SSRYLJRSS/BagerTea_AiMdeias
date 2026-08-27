/**
 * 分面管理面板（指导书 §9.2/§9.5/§12.4）：分类大类的唯一管理入口。
 *  - 分面 = tag_facets 唯一事实源；key 创建后锁定；
 *  - 每个分面详情同一上下文内完成三块：
 *      ① 基本规则（显示名/描述/单选多选/上限/适用媒体）→ 后端即时事务；
 *      ② AI 行为（是否参与 AI / 给 AI 的说明 / 工作台显示）→ 设置草稿（随页面保存统一落库）；
 *      ③ 分类词条（TagManageDialog 二级编辑器，标题体现当前分面上下文）。
 *  - 停用前展示影响范围（标签数 / 素材数 / AI 配置数）。
 */
import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import Button from "@/components/common/Button";
import TagManageDialog from "@/components/dialogs/TagManageDialog";
import {
  createTagFacet,
  deactivateTagFacet,
  getTagFacetImpact,
  listAllTagFacets,
  restoreTagFacet,
  updateTagFacetDisplay,
  updateTagFacetRules,
} from "@/api/tags";
import type { TagFacet } from "@/types/tag";

const APP_TO_OPTIONS: { value: "all" | "image" | "video"; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "image", label: "图片" },
  { value: "video", label: "视频" },
];

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^[0-9]+/, "") // 不以数字开头
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

/** 该分面的 AI 行为覆盖字段（来自设置草稿 aiFacetConfigs，随页面保存统一落库） */
export interface AiFacetConfigView {
  facetKey: string;
  enabledForAi: boolean;
  hint: string;
  visibleInWorkbench: boolean;
}

interface Props {
  /** 设置草稿中的 AI 行为覆盖（按 facetKey 查找；缺省用默认值） */
  aiConfigs?: AiFacetConfigView[];
  onPatchAiConfig?: (facetKey: string, patch: Partial<Omit<AiFacetConfigView, "facetKey">>) => void;
}

export default function FacetManagePanel({ aiConfigs = [], onPatchAiConfig }: Props) {
  const [facets, setFacets] = useState<TagFacet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** 分类词条二级编辑器：记录「从哪个分面打开」，标题体现上下文（§9.3） */
  const [termsFacet, setTermsFacet] = useState<TagFacet | null>(null);

  const configFor = (key: string): AiFacetConfigView =>
    aiConfigs.find((c) => c.facetKey === key) ?? {
      facetKey: key,
      enabledForAi: true,
      hint: "",
      visibleInWorkbench: true,
    };

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

  return (
    <div className="flex flex-col gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium text-[var(--color-text)]">分类大类（分面）</h4>
        <Button onClick={() => setCreating((v) => !v)}>{creating ? "取消" : "+ 新增分类"}</Button>
      </div>
      <p className="text-[11px] leading-4 text-[var(--color-text-secondary)]">
        分类大类 = 标签大类（如「人物服装颜色」）。创建后 key 锁定不可改；停用保留历史标签与查询。每个分类的规则、AI 行为与词条在同一个详情中维护。
      </p>

      {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}
      {notice && <p className="text-xs text-[var(--color-text-secondary)]">{notice}</p>}

      {creating && <CreateForm onCreated={() => { setCreating(false); void refresh(); }} onCancel={() => setCreating(false)} />}

      {loading ? (
        <p className="text-xs text-[var(--color-text-secondary)]">加载分类…</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {facets.map((f) => (
            <FacetDetail
              key={f.key}
              facet={f}
              config={configFor(f.key)}
              onPatchAiConfig={(patch) => onPatchAiConfig?.(f.key, patch)}
              onSaveStructure={(m) => { setNotice(m); void refresh(); }}
              onError={setError}
              onDeactivate={() =>
                run(async () => {
                  const impact = await getTagFacetImpact(f.key);
                  const more = impact.tagCount > 0 || impact.assetCount > 0 || impact.aiConfigCount > 0;
                  const msg = `该分类下有 ${impact.tagCount} 个标签、被 ${impact.assetCount} 个素材引用、${impact.aiConfigCount} 条 AI 配置。`;
                  if (more && !window.confirm(`停用后保留历史标签与查询。${msg}仍要停用？`)) return;
                  await deactivateTagFacet(f.key);
                }, "已停用")
              }
              onRestore={() => run(() => restoreTagFacet(f.key), "已恢复")}
              onOpenTerms={() => setTermsFacet(f)}
            />
          ))}
        </ul>
      )}

      {/* §9.3：分类词条只作为分面详情内的二级编辑器，标题体现上下文 */}
      <TagManageDialog
        open={termsFacet != null}
        onClose={() => setTermsFacet(null)}
        title={termsFacet ? `分类词条：${termsFacet.displayName}` : "分类词条"}
      />
    </div>
  );
}

/** 单个分面详情：基本规则 + AI 行为 + 分类词条入口（同一上下文，§9.2） */
function FacetDetail({
  facet,
  config,
  onPatchAiConfig,
  onSaveStructure,
  onError,
  onDeactivate,
  onRestore,
  onOpenTerms,
}: {
  facet: TagFacet;
  config: AiFacetConfigView;
  onPatchAiConfig: (patch: Partial<Omit<AiFacetConfigView, "facetKey">>) => void;
  onSaveStructure: (msg: string) => void;
  onError: (msg: string) => void;
  onDeactivate: () => void;
  onRestore: () => void;
  onOpenTerms: () => void;
}) {
  const active = facet.status === "active";
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState(facet.displayName);
  const [description, setDescription] = useState(facet.description);
  const [selectionMode, setSelectionMode] = useState<"single" | "multi">(facet.selectionMode as "single" | "multi");
  const [maxItems, setMaxItems] = useState<string>(facet.maxItems ? String(facet.maxItems) : "");
  const [appliesTo, setAppliesTo] = useState<"all" | "image" | "video">(facet.appliesTo as "all" | "image" | "video");
  const [saving, setSaving] = useState(false);

  const submitStructure = async () => {
    setSaving(true);
    try {
      await updateTagFacetDisplay(facet.key, displayName, description);
      await updateTagFacetRules(facet.key, selectionMode, selectionMode === "single" ? 1 : maxItems ? Number(maxItems) || null : null, appliesTo);
      onSaveStructure("已保存（历史标签与查询不受影响）");
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <li className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
      >
        <span className={clsx("text-xs", !active && "text-[var(--color-text-secondary)] line-through")}>
          {facet.displayName}
        </span>
        <span className="shrink-0 rounded bg-[var(--color-surface-hover)] px-1 text-[10px] text-[var(--color-text-secondary)]" title={facet.key}>
          {facet.key}
        </span>
        {facet.isSystem && <span className="shrink-0 rounded bg-[var(--color-surface-hover)] px-1 text-[10px] text-[var(--color-text-secondary)]">系统</span>}
        <span className="ml-auto shrink-0 text-[10px] text-[var(--color-text-secondary)]">
          {APP_TO_OPTIONS.find((o) => o.value === facet.appliesTo)?.label ?? "全部"} ·{" "}
          {facet.selectionMode === "single" ? "单选" : `多选${facet.maxItems ? `（≤${facet.maxItems}）` : ""}`} ·{" "}
          {active ? "启用" : "停用"}
          <span className="ml-1 inline-block">{open ? "▲" : "▼"}</span>
        </span>
      </button>

      {open && (
        <div className="flex flex-col gap-2 border-t border-[var(--color-border)] p-2">
          {/* ① 基本规则（即时保存） */}
          <div className="flex flex-col gap-1.5">
            <p className="text-[10px] font-medium tracking-wide text-[var(--color-text-secondary)] uppercase">基本规则</p>
            <input className="ui-control px-2 py-1 text-sm" value={displayName} onChange={(e) => setDisplayName(e.target.value)} aria-label="显示名" />
            <input className="ui-control px-2 py-1 text-sm" placeholder="描述" value={description} onChange={(e) => setDescription(e.target.value)} aria-label="描述" />
            <div className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
              <label className="flex items-center gap-1"><input type="radio" checked={selectionMode === "single"} onChange={() => setSelectionMode("single")} />单选</label>
              <label className="flex items-center gap-1"><input type="radio" checked={selectionMode === "multi"} onChange={() => setSelectionMode("multi")} />多选</label>
              {selectionMode === "multi" && (
                <input className="ui-control w-16 px-1 py-0.5 text-xs" type="number" min={1} value={maxItems} onChange={(e) => setMaxItems(e.target.value)} placeholder="上限" aria-label="最大数量" />
              )}
              <select className="ui-control rounded px-1 py-0.5 text-xs" value={appliesTo} onChange={(e) => setAppliesTo(e.target.value as typeof appliesTo)} aria-label="适用媒体">
                {APP_TO_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <Button variant="primary" disabled={saving} onClick={() => void submitStructure()}>
                {saving ? "保存中…" : "保存规则"}
              </Button>
            </div>
          </div>

          {/* ② AI 行为（随设置草稿保存，与页面保存按钮同一语义） */}
          <div className="flex flex-col gap-1.5">
            <p className="text-[10px] font-medium tracking-wide text-[var(--color-text-secondary)] uppercase">AI 行为</p>
            <label className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)]">
              <input type="checkbox" checked={config.enabledForAi} onChange={(e) => onPatchAiConfig({ enabledForAi: e.target.checked })} />
              参与 AI 打标与搜索
            </label>
            <input
              className="ui-control px-2 py-1 text-xs"
              value={config.hint}
              onChange={(e) => onPatchAiConfig({ hint: e.target.value })}
              placeholder="给 AI 的分类说明（hint）"
              aria-label="给 AI 的分类说明"
            />
            <label className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)]">
              <input type="checkbox" checked={config.visibleInWorkbench} onChange={(e) => onPatchAiConfig({ visibleInWorkbench: e.target.checked })} />
              在打标工作台显示
            </label>
            <p className="text-[10px] text-[var(--color-text-tertiary)]">AI 行为随「保存设置」按钮统一落库。</p>
          </div>

          {/* ③ 分类词条（二级编辑器，标题体现上下文） */}
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-medium tracking-wide text-[var(--color-text-secondary)] uppercase">分类词条</p>
            <Button onClick={onOpenTerms}>管理词条</Button>
          </div>

          {/* 停用/恢复 */}
          {active ? (
            <button onClick={onDeactivate} className="self-start rounded px-1.5 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-red-500">
              停用分类
            </button>
          ) : (
            <button onClick={onRestore} className="self-start rounded px-1.5 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]">
              恢复分类
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function CreateForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [displayName, setDisplayName] = useState("");
  const [key, setKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [selectionMode, setSelectionMode] = useState<"single" | "multi">("multi");
  const [maxItems, setMaxItems] = useState<string>("3");
  const [appliesTo, setAppliesTo] = useState<"all" | "image" | "video">("all");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 自动生成 key（仅当用户未手动编辑时）；创建后锁定
  const effectiveKey = keyTouched ? key : slugify(displayName);

  const submit = async () => {
    setErr(null);
    if (!displayName.trim()) return setErr("请填写显示名");
    if (!effectiveKey.trim()) return setErr("请填写或生成稳定 key");
    setSaving(true);
    try {
      await createTagFacet({
        key: effectiveKey,
        displayName: displayName.trim(),
        description,
        selectionMode,
        maxItems: selectionMode === "single" ? 1 : maxItems ? Number(maxItems) || null : null,
        appliesTo,
      });
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
      <input className="ui-control px-2 py-1 text-sm" placeholder="显示名称（必填）" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      <div className="flex items-center gap-2">
        <input className="ui-control w-1/2 px-2 py-1 text-sm" placeholder="稳定 key（自动生成，可改）" value={effectiveKey} onChange={(e) => { setKey(slugify(e.target.value)); setKeyTouched(true); }} />
        <span className="text-[10px] text-[var(--color-text-secondary)]">创建后锁定</span>
      </div>
      <input className="ui-control px-2 py-1 text-sm" placeholder="描述（可选）" value={description} onChange={(e) => setDescription(e.target.value)} />
      <div className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
        <label className="flex items-center gap-1"><input type="radio" checked={selectionMode === "single"} onChange={() => setSelectionMode("single")} />单选</label>
        <label className="flex items-center gap-1"><input type="radio" checked={selectionMode === "multi"} onChange={() => setSelectionMode("multi")} />多选</label>
        {selectionMode === "multi" && (
          <input className="ui-control w-16 px-1 py-0.5 text-xs" type="number" min={1} value={maxItems} onChange={(e) => setMaxItems(e.target.value)} placeholder="上限" />
        )}
        <select className="ui-control rounded px-1 py-0.5 text-xs" value={appliesTo} onChange={(e) => setAppliesTo(e.target.value as typeof appliesTo)}>
          {APP_TO_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      {err && <p className="text-xs text-[var(--color-danger)]">{err}</p>}
      <div className="flex gap-2">
        <Button variant="primary" disabled={saving} onClick={() => void submit()}>{saving ? "创建中…" : "创建分类"}</Button>
        <Button onClick={onCancel}>取消</Button>
      </div>
    </div>
  );
}