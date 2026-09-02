/**
 * F2-e「标签与分类」下的数据完整性区块：
 * 展示 schema_features 四项能力状态 + 未生效原因 + 「预检冲突 / 启用约束」按钮。
 * 启用约束前置：预检必须干净；有冲突给出冲突摘要（设置页下一步做逐条处理）。
 */
import { useCallback, useEffect, useState } from "react";
import Button from "@/components/common/Button";
import {
  applyTagConstraints,
  detectTagConstraintsConflicts,
  listTagConstraintFeatures,
  type SchemaFeatureStatus,
  type TagConflictReport,
} from "@/api/tags";

/** 与 SettingsPage 内 Field 同构的字段容器（避免跨文件耦合 SettingsPage 内部组件） */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-[var(--color-border)] py-2">
      <div className="flex items-center justify-between gap-2 px-4">
        <div className="min-w-0">
          <div className="text-sm font-medium text-[var(--color-text)]">{label}</div>
          {hint && <div className="mt-0.5 text-xs text-[var(--color-text-tertiary)]">{hint}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}

const FEATURE_LABELS: Record<string, string> = {
  tag_cycle_guard: "环检测与深度上限",
  tag_unique_terms: "规范名/别名唯一词条（前缀/包含/纠错匹配的前提）",
  tag_facet_fk: "标签归属分面校验",
  tag_facet_restrict_delete: "带标签分面禁止裸删除",
};

export default function DataIntegrityPanel() {
  const [features, setFeatures] = useState<SchemaFeatureStatus[]>([]);
  const [report, setReport] = useState<TagConflictReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setFeatures(await listTagConstraintFeatures());
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onDetect = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await detectTagConstraintsConflicts();
      setReport(r);
      if (
        r.termConflicts.length === 0 &&
        r.orphans.length === 0 &&
        r.crossFacetChildren.length === 0 &&
        r.cycleEdges.length === 0 &&
        r.overDeepSubtrees.length === 0 &&
        r.facetMismatches.length === 0
      ) {
        setMessage("未发现标签数据冲突，可以启用约束");
      } else {
        setMessage(
          `发现冲突：分面内重名 ${r.termConflicts.length} 组 · 孤儿 ${r.orphans.length} · 跨面挂父 ${r.crossFacetChildren.length} · 环 ${r.cycleEdges.length} · 超深 ${r.overDeepSubtrees.length} · 分面不一致 ${r.facetMismatches.length}`,
        );
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onApply = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await applyTagConstraints();
      setMessage("约束已启用：规范名/别名唯一、分面引用校验、删除保护全部生效");
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const enabledCount = features.filter((f) => f.enabled).length;

  return (
    <Field
      label={`标签数据完整性（${enabledCount}/${features.length} 项生效）`}
      hint="启用后：同分面内一个词（规范名/别名）只能属于一个标签；标签必须属于真实存在的分面；前缀/包含/纠错搜索可用。启用前会先检查现有数据是否有冲突"
    >
      <div className="flex flex-col gap-2">
        <ul className="flex flex-col gap-1 text-xs">
          {features.map((f) => (
            <li key={f.feature} className="flex items-center justify-between gap-2">
              <span className={f.enabled ? "" : "text-[var(--color-text-secondary)]"}>
                {FEATURE_LABELS[f.feature] ?? f.feature}
              </span>
              <span
                className={
                  f.enabled
                    ? "text-[var(--color-status)]"
                    : f.blockedBy && f.blockedBy !== "pending"
                      ? "text-[var(--color-danger)]"
                      : "text-[var(--color-text-tertiary)]"
                }
              >
                {f.enabled ? "已生效" : f.blockedBy === "pending" ? "待启用" : `未生效（${f.blockedBy ?? "未知原因"}）`}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-2">
          <Button disabled={busy} onClick={() => void onDetect()}>
            {busy ? "处理中…" : "检查标签冲突"}
          </Button>
          <Button
            disabled={busy || enabledCount === features.length}
            onClick={() => void onApply()}
          >
            启用约束
          </Button>
        </div>
        {message && <p className="text-xs text-[var(--color-text-secondary)]">{message}</p>}
        {report && report.termConflicts.length > 0 && (
          <div className="max-h-40 overflow-y-auto rounded border border-[var(--color-border)] p-2 text-xs">
            <p className="mb-1 font-medium">分面内重名词条（需先合并再启用）：</p>
            {report.termConflicts.slice(0, 20).map((g) => (
              <p key={`${g.facetKey}/${g.term}`} className="text-[var(--color-text-secondary)]">
                「{g.term}」在 {g.facetKey} 分面有 {g.entries.length} 个条目
                （{g.entries.map((e) => `${e.name}(${e.linkedAssets})`).join(" / ")}）
              </p>
            ))}
            {report.termConflicts.length > 20 && (
              <p className="text-[var(--color-text-tertiary)]">…还有 {report.termConflicts.length - 20} 组</p>
            )}
          </div>
        )}
      </div>
    </Field>
  );
}
