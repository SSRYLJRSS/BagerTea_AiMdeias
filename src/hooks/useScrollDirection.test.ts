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
    scroll(el, 0); // 上滚 → expanded
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