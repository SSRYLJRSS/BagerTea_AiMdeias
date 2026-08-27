import { beforeEach, describe, expect, it } from "vitest";
import { useTaskStore, importOverall, upsertImport } from "@/stores/taskStore";
import type { ImportProgress } from "@/api/import";

beforeEach(() => {
  useTaskStore.setState({ tasks: [] });
});

function ev(partial: Partial<ImportProgress>): ImportProgress {
  return {
    taskId: "t1",
    phase: "scanning",
    phaseCurrent: 0,
    phaseTotal: null,
    imported: 0,
    duplicates: 0,
    failed: 0,
    ...partial,
  };
}

describe("importOverall（阶段权重 → 整体进度）", () => {
  it("queued 无权重 → 不确定", () => {
    expect(importOverall("queued", 0, null)).toBeNull();
  });

  it("scanning 总量未知 → 不确定进度", () => {
    expect(importOverall("scanning", 5, null)).toBeNull();
  });

  it("hashing 按权重计算整体进度", () => {
    // scanning(0.05) 已完成 + hashing(0.25) * 10/100
    expect(importOverall("hashing", 10, 100)).toBeCloseTo(0.05 + 0.25 * 0.1, 5);
  });

  it("processing/previewing 按权重累加", () => {
    // 0.05+0.25 + 0.5 * 0.4 = 0.5
    expect(importOverall("processing", 200, 500)).toBeCloseTo(0.5, 5);
    // 0.05+0.25+0.5 + 0.2 * 0.5 = 0.9
    expect(importOverall("previewing", 50, 100)).toBeCloseTo(0.9, 5);
  });

  it("done → 1", () => {
    expect(importOverall("done", 0, null)).toBe(1);
  });

  it("阶段切换不会造成整体进度倒退", () => {
    const processing = importOverall("processing", 200, 500);
    const next = importOverall("previewing", 0, 100);
    expect(next).toBeGreaterThanOrEqual(processing!);
  });
});

describe("全局任务条（taskStore）", () => {
  it("入库任务按 taskId 去重，只产生一条展示条", () => {
    upsertImport(ev({ phase: "scanning", phaseCurrent: 3, phaseTotal: null }));
    upsertImport(ev({ phase: "hashing", phaseCurrent: 10, phaseTotal: 100 }));
    const tasks = useTaskStore.getState().tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("t1");
    expect(tasks[0].overall).toBeCloseTo(0.05 + 0.25 * 0.1, 5);
  });

  it("旧 taskId 事件不会污染新任务", () => {
    upsertImport(ev({ taskId: "old", phase: "hashing", phaseCurrent: 99, phaseTotal: 100 }));
    upsertImport(ev({ taskId: "new", phase: "queued", phaseCurrent: 0, phaseTotal: null }));
    const ids = useTaskStore.getState().tasks.map((t) => t.id);
    expect(ids).toContain("new");
    expect(ids).toContain("old");
    // 新任务显示不确定（queued），不被旧任务整体进度覆盖
    const newTask = useTaskStore.getState().tasks.find((t) => t.id === "new")!;
    expect(newTask.overall).toBeNull();
  });

  it("失败任务保留文字与状态（done 时错误数 > 0）", () => {
    upsertImport(ev({ phase: "done", phaseCurrent: 100, phaseTotal: 100, imported: 100, duplicates: 0, failed: 2, message: "入库完成" }));
    const task = useTaskStore.getState().tasks.find((t) => t.id === "t1")!;
    expect(task.error).toContain("失败 2");
    expect(task.done).toBe(true);
  });

  it("阶段切换不倒退（任务条整体进度单调不减）", () => {
    let prev = -1;
    for (const [phase, current, total] of [["hashing", 0, 100], ["hashing", 100, 100], ["processing", 0, 100], ["processing", 100, 100], ["previewing", 0, 100], ["previewing", 100, 100]] as const) {
      const overall = importOverall(phase as ImportProgress["phase"], current, total!);
      if (overall == null) continue;
      expect(overall).toBeGreaterThanOrEqual(prev);
      prev = overall;
    }
  });
});
