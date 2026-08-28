/** FB2-03 全局唯一视频槽测试（§12.3 护栏：任何时候最多 1 个 <video> 在播） */
import { describe, expect, it, vi } from "vitest";
import { acquireVideoSlot } from "@/utils/videoSlot";

describe("acquireVideoSlot（FB2-03 单实例护栏）", () => {
  it("激活第二张时，第一张被抢占（pause 调用）且让位", () => {
    const pauseA = vi.fn();
    const releaseA = acquireVideoSlot("a", pauseA);
    const pauseB = vi.fn();
    const releaseB = acquireVideoSlot("b", pauseB);
    expect(pauseA).toHaveBeenCalledTimes(1); // A 被 B 抢占
    // A 释放不应清掉 B 的槽
    releaseA();
    expect(pauseB).not.toHaveBeenCalled();
    // B 释放后清空
    releaseB();
    // 再激活 C 不应 pause 任何已释放者
    const pauseC = vi.fn();
    acquireVideoSlot("c", pauseC);
    expect(pauseB).toHaveBeenCalledTimes(0);
    expect(pauseC).toHaveBeenCalledTimes(0);
  });

  it("同一 key 重复占用幂等：不触发自身 pause", () => {
    const pause = vi.fn();
    const r1 = acquireVideoSlot("x", pause);
    const r2 = acquireVideoSlot("x", pause);
    expect(pause).not.toHaveBeenCalled();
    r1();
    r2();
  });
});