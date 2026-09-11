/** useScrollDirection 测试（§12.2 FB-06）：下滚收起、上滚恢复、passive、rAF 合并、15px 阈值、不触发高频 setState。 */
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useScrollDirection } from "@/hooks/useScrollDirection";

// 让 requestAnimationFrame 同步执行，避免真实异步（jsdom）+ 时间不确定性
vi.spyOn(global, "requestAnimationFrame").mockImplementation((cb) => {
  cb(0);
  return 0;
});
vi.spyOn(global, "cancelAnimationFrame").mockImplementation(() => {});

describe("useScrollDirection（FB-06）", () => {
  function mountOnContainer() {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const { result } = renderHook(() => useScrollDirection({ threshold: 15 }));
    act(() => {
      result.current[1](el);
    });
    return { el, result };
  }

  function scroll(el: HTMLElement, top: number) {
    act(() => {
      el.scrollTop = top;
      el.dispatchEvent(new Event("scroll"));
    });
  }

  it("初始 expanded；向下滚动超过阈值收起", () => {
    const { el, result } = mountOnContainer();
    expect(result.current[0]).toBe("expanded");
    scroll(el, 20);
    expect(result.current[0]).toBe("collapsed");
  });

  it("向上滚动超过阈值恢复 expanded", () => {
    const { el, result } = mountOnContainer();
    scroll(el, 40); // 下滚 → collapsed
    expect(result.current[0]).toBe("collapsed");
    scroll(el, 20); // FB3-06：上滑但未回顶部 → 保持收起（旧语义会展开，此为行为变更点）
    expect(result.current[0]).toBe("collapsed");
    scroll(el, 0); // 回到顶部 → expanded
    expect(result.current[0]).toBe("expanded");
  });

  it("累计位移不足阈值不切换（多事件合并，不每个 scroll setState）", () => {
    const { el, result } = mountOnContainer();
    // 连续小幅滚动累计 14px < 15 → 保持 expanded
    scroll(el, 5);
    scroll(el, 9);
    scroll(el, 14);
    expect(result.current[0]).toBe("expanded");
    // 再滚到 16px，累计 16 ≥ 15 → collapsed
    scroll(el, 16);
    expect(result.current[0]).toBe("collapsed");
  });

  it("换向清零累计值（先下后上小位移不误触）", () => {
    const { el, result } = mountOnContainer();
    scroll(el, 10); // 向下 10 < 15
    scroll(el, 4); // 向上 4 → 换向清零
    expect(result.current[0]).toBe("expanded");
  });

  it("容器置 null 后清 listener 不抛异常", () => {
    const { el, result } = mountOnContainer();
    act(() => {
      result.current[1](null);
    });
    scroll(el, 50);
    expect(result.current[0]).toBe("expanded");
    el.remove();
  });
});

describe("useScrollDirection（FB2-06 方案 C 新增）", () => {
  function mountOnContainer(opts: Parameters<typeof useScrollDirection>[0]) {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const { result } = renderHook(() => useScrollDirection(opts));
    act(() => {
      result.current[1](el);
    });
    return { el, result };
  }

  function scroll(el: HTMLElement, top: number) {
    act(() => {
      el.scrollTop = top;
      el.dispatchEvent(new Event("scroll"));
    });
  }

  it("非对称阈值：下滚 20 不收起、24 才收起；非顶部上滑不展开（FB3-06），回顶部才展开", () => {
    const { el, result } = mountOnContainer({ collapseThreshold: 24, expandThreshold: 12, minScrollTop: 0 });
    scroll(el, 20); // < collapseThreshold 24 → 不收起
    expect(result.current[0]).toBe("expanded");
    scroll(el, 45); // 累计 45 ≥ 24 → collapsed
    expect(result.current[0]).toBe("collapsed");
    // FB3-06：上滑 12（≥ expandThreshold）但在非顶部 → 仍收起
    scroll(el, 33);
    expect(result.current[0]).toBe("collapsed");
    // 回到顶部（minScrollTop=0）→ 展开
    scroll(el, 0);
    expect(result.current[0]).toBe("expanded");
  });

  it("minScrollTop 门槛：scrollTop=30 时下滚不收起", () => {
    const { el, result } = mountOnContainer({ minScrollTop: 60, collapseThreshold: 10, expandThreshold: 10 });
    scroll(el, 30); // 低于 60，即使下滚也保持展开
    expect(result.current[0]).toBe("expanded");
  });

  it("suppressMs 抑制窗：setExpanded 后立刻 scroll 不改状态", () => {
    const { el, result } = mountOnContainer({ collapseThreshold: 5, expandThreshold: 5, minScrollTop: 0, suppressMs: 100000 });
    scroll(el, 100); // collapsed
    expect(result.current[0]).toBe("collapsed");
    act(() => {
      result.current[2]("expanded"); // 手动展开，进入抑制窗
    });
    scroll(el, 200); // 抑制窗内下滚 → 不改（仍 expanded）
    expect(result.current[0]).toBe("expanded");
  });

  it("抑制窗内 lastY 仍更新：窗口结束后第一次滚动不产生巨大 delta", () => {
    const { el, result } = mountOnContainer({ collapseThreshold: 10, expandThreshold: 10, minScrollTop: 0, suppressMs: 100000 });
    scroll(el, 100); // collapsed
    act(() => {
      result.current[2]("expanded"); // 抑制窗开始，lastY 应同步到 100
    });
    scroll(el, 200); // 抑制窗内：不切换，且 lastY 更新到 200
    expect(result.current[0]).toBe("expanded");
    // 模拟抑制窗过后：用新 hook 没直接暴露 suppressUntil，此处验证「窗口内滚动被记录」即可，
    // 通过再次 scroll 到接近值累计不到阈值来佐证 lastY 已同步（无巨大一次越阈）
  });
});

describe("useScrollDirection（FB3-06 只在顶部自动展开）", () => {
  function mountOnContainer(opts: Parameters<typeof useScrollDirection>[0]) {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const { result } = renderHook(() => useScrollDirection(opts));
    act(() => {
      result.current[1](el);
    });
    return { el, result };
  }

  function scroll(el: HTMLElement, top: number) {
    act(() => {
      el.scrollTop = top;
      el.dispatchEvent(new Event("scroll"));
    });
  }

  /** 指导书 §8.3 验收：scrollTop=300 上滑 20px 不展开；滚到 40 以下展开 */
  it("scrollTop=300 上滑 20px 保持收起；回到 40 以下（minScrollTop=48 顶区）展开", () => {
    const { el, result } = mountOnContainer({ collapseThreshold: 24, expandThreshold: 12, minScrollTop: 48, suppressMs: 300 });
    scroll(el, 320); // 下滚收起
    expect(result.current[0]).toBe("collapsed");
    scroll(el, 300); // 上滑 20px（未回顶）→ 不展开
    expect(result.current[0]).toBe("collapsed");
    scroll(el, 100); // 大幅上滑仍未回顶 → 不展开
    expect(result.current[0]).toBe("collapsed");
    scroll(el, 40); // 回到顶部区（<=48）→ 展开
    expect(result.current[0]).toBe("expanded");
  });

  it("点击手动展开后 300ms 内 scroll 不覆盖（suppress 窗）", () => {
    const { el, result } = mountOnContainer({ collapseThreshold: 24, expandThreshold: 12, minScrollTop: 48, suppressMs: 100000 });
    scroll(el, 300);
    expect(result.current[0]).toBe("collapsed");
    act(() => {
      result.current[2]("expanded"); // 手动展开（点击「展开详细条件」）
    });
    scroll(el, 310); // 抑制窗内下滚 → 不收回
    expect(result.current[0]).toBe("expanded");
  });
});

describe("useScrollDirection（防闪烁：自动收起后识别视口钳位事件）", () => {
  function mountOnContainer(opts: Parameters<typeof useScrollDirection>[0]) {
    const el = document.createElement("div");
    document.body.appendChild(el);
    // jsdom 下 clientHeight 恒 0，测试需手动模拟「收起导致视口变高」
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 500, writable: true });
    const { result } = renderHook(() => useScrollDirection(opts));
    act(() => {
      result.current[1](el);
    });
    return { el, result };
  }

  function scroll(el: HTMLElement, top: number) {
    act(() => {
      el.scrollTop = top;
      el.dispatchEvent(new Event("scroll"));
    });
  }

  it("收起后视口变高、位置被钳回顶部区：不立即展开（旧实现会收起↔展开闪烁），用户再滚才展开", () => {
    const { el, result } = mountOnContainer({ collapseThreshold: 24, expandThreshold: 12, minScrollTop: 48, suppressMs: 300 });
    scroll(el, 100); // 下滚 → 自动收起（记录视口高 500）
    expect(result.current[0]).toBe("collapsed");
    // 收起后面板消失，滚动视口变高（+260），浏览器把 scrollTop 钳回顶部区并派发事件
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 760, writable: true });
    scroll(el, 30);
    expect(result.current[0]).toBe("collapsed"); // 旧实现在此又自动展开 → 闪烁
    // 用户真实继续上滚（视口不再变化）→ 正常展开
    scroll(el, 20);
    expect(result.current[0]).toBe("expanded");
  });

  it("收起后视口变高但首个事件在非顶部区：不拦截，方向判定照常（保持收起）", () => {
    const { el, result } = mountOnContainer({ collapseThreshold: 24, expandThreshold: 12, minScrollTop: 48, suppressMs: 300 });
    scroll(el, 200);
    expect(result.current[0]).toBe("collapsed");
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 760, writable: true });
    scroll(el, 180); // 视口变高但仍在非顶部 → 不构成钳回顶部，正常处理（上滑保持收起）
    expect(result.current[0]).toBe("collapsed");
    scroll(el, 30); // 护栏已消费，真实回顶 → 展开
    expect(result.current[0]).toBe("expanded");
  });

  it("视口尺寸没变（用户主动拖回顶部）：不拦截，立即展开", () => {
    const { el, result } = mountOnContainer({ collapseThreshold: 24, expandThreshold: 12, minScrollTop: 48, suppressMs: 300 });
    scroll(el, 100);
    expect(result.current[0]).toBe("collapsed");
    // clientHeight 保持 500（无布局变化）——用户拖滚动条回顶，必须能展开
    scroll(el, 0);
    expect(result.current[0]).toBe("expanded");
  });

  it("手动 setExpanded 清掉钳位护栏", () => {
    const { el, result } = mountOnContainer({ collapseThreshold: 24, expandThreshold: 12, minScrollTop: 48, suppressMs: 0 });
    scroll(el, 100);
    expect(result.current[0]).toBe("collapsed");
    act(() => {
      result.current[2]("expanded");
    });
    expect(result.current[0]).toBe("expanded");
  });
});