/** 模型选择器：自动从 {base_url}/models 拉取可选模型下拉选择（PRD 5.3 设置页①，R-06）
 *  - 进入时若已配置 base_url 自动拉取一次（本地服务无需 API Key，P3-01a），失败/为空可手动重试或手输
 *  - 设置页与 AI 打标页共用
 */
import { useCallback, useEffect, useState } from "react";
import { aiListModels } from "@/api/ai";

interface ModelSelectProps {
  apiMode: string;
  baseUrl: string;
  apiKey: string;
  value: string;
  onChange: (v: string) => void;
}

export default function ModelSelect({ apiMode, baseUrl, apiKey, value, onChange }: ModelSelectProps) {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchModels = useCallback(async () => {
    if (!baseUrl.trim()) {
      setError("请先填写 Base URL");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const list = await aiListModels(baseUrl, apiKey, apiMode);
      setModels(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [apiMode, baseUrl, apiKey]);

  // 进入时自动拉取一次（仅在 base_url 已配置时；本地服务无 Key 也可拉）
  useEffect(() => {
    if (baseUrl.trim()) void fetchModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inputCls =
    "w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text)] outline-none";

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        {models.length > 0 ? (
          <select value={value} onChange={(e) => onChange(e.target.value)} className={inputCls}>
            {!models.includes(value) && value && <option value={value}>{value}（当前）</option>}
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="qwen-vl-max"
            className={inputCls}
          />
        )}
        <button
          onClick={() => void fetchModels()}
          disabled={loading}
          className="shrink-0 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] disabled:opacity-50"
        >
          {loading ? "获取中…" : models.length > 0 ? "刷新" : "获取模型列表"}
        </button>
      </div>
      {error && <span className="text-xs text-red-500">{error}</span>}
    </div>
  );
}
