/** Ollama 一键配置共用 hooks（A2/A3 共用）：模型拉取状态机（进度事件 → 本地 state） */
import { useCallback, useState } from "react";
import { onOllamaPullProgress, pullOllamaModel, type OllamaPullProgress } from "@/api/ollama";
import { useTauriEvent } from "@/hooks/hooks";

/** 一键拉取：进度走 ollama://pull-progress 事件；失败向上抛由调用方提示 */
export function useOllamaPull() {
    const [pullState, setPullState] = useState<OllamaPullProgress | null>(null);
    const [pullBusy, setPullBusy] = useState(false);

    useTauriEvent(() => onOllamaPullProgress((p) => setPullState(p)), []);

    const pull = useCallback(async (baseUrl: string, model: string) => {
        setPullBusy(true);
        setPullState({ model, status: "正在连接…", total: 0, completed: 0, done: false, error: null });
        try {
            await pullOllamaModel(baseUrl, model);
        } finally {
            setPullBusy(false);
        }
    }, []);

    return { pullState, pullBusy, pull };
}
