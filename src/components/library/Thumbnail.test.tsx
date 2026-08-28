/**
 * Thumbnail 稳定性测试（指导书 §9.2/§9.3）：
 *  - 模块级缓存：重挂载命中 ready 后立即显示高清并跳过重复淡入（hdReady=true）；
 *  - 代际保护：卸载后旧 Promise 不得更新新素材状态（不抛错）；
 *  - 占位图失败会触发高清请求；
 *  - 同一 asset+size 的并发请求合并为一个（single-flight）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import Thumbnail from "@/components/library/Thumbnail";
import { getThumbnailUrl } from "@/api/thumbnail";
import { clearThumbnailCache } from "@/utils/thumbnailCache";

vi.mock("@/api/thumbnail", () => ({
  getThumbnailUrl: vi.fn(),
  toFileUrl: (p: string) => `asset://${p}`,
}));

// 可控 IntersectionObserver：收集实例，测试里手动触发 intersecting
let observers: { cb: IntersectionObserverCallback }[] = [];
vi.stubGlobal("IntersectionObserver", class {
  cb: IntersectionObserverCallback;
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
    observers.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
});

function fireVisible() {
  for (const o of observers) {
    o.cb([{ isIntersecting: true } as IntersectionObserverEntry], o as unknown as IntersectionObserver);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  clearThumbnailCache();
  observers = [];
});

describe("Thumbnail 高清缓存与代际保护", () => {
  it("命中 ready 缓存的重挂载：立即显示高清，hdReady=true（跳过重复淡入）", async () => {
    vi.mocked(getThumbnailUrl).mockResolvedValue("asset://hd/1");
    const first = render(<Thumbnail assetId={1} placeholderPath="d:/t/p1.jpg" alt="a" size={512} fit="cover" />);
    fireVisible();
    // 第一次请求完成 → 高清显示
    await waitFor(() => {
      const hd = first.container.querySelector('img[src="asset://hd/1"]');
      expect(hd).not.toBeNull();
      expect((hd as HTMLImageElement).style.opacity).toBe("1");
    });
    first.unmount();

    // 重挂载同一素材：缓存命中，hdUrl 立即存在且 hdReady=true
    const second = render(<Thumbnail assetId={1} placeholderPath="d:/t/p1.jpg" alt="a" size={512} fit="cover" />);
    const hd = second.container.querySelector('img[src="asset://hd/1"]');
    expect(hd).not.toBeNull();
    expect((hd as HTMLImageElement).style.opacity).toBe("1");
    // 不应再发起新的 getThumbnailUrl（缓存命中）
    expect(vi.mocked(getThumbnailUrl)).toHaveBeenCalledTimes(1);
  });

  it("代际保护：卸载后旧 Promise 完成不更新新素材（不抛错、不串图）", async () => {
    let resolveFn: (u: string) => void = () => {};
    vi.mocked(getThumbnailUrl).mockReturnValue(new Promise<string>((r) => (resolveFn = r)));
    const first = render(<Thumbnail assetId={1} placeholderPath={null} alt="a" size={512} fit="cover" />);
    fireVisible(); // 发起请求（挂起）
    // 卸载：代际推进
    first.unmount();
    // 让旧请求完成——应被代际保护丢弃，不抛错
    resolveFn("asset://hd/old");
    await waitFor(() => {
      // 不影响任何已挂载组件：无异常即通过；这里再次挂载新素材确认不被旧 URL 污染
      const second = render(<Thumbnail assetId={2} placeholderPath={null} alt="b" size={512} fit="cover" />);
      expect(second.container.querySelector('img[src="asset://hd/old"]')).toBeNull();
    });
  });

  it("占位图加载失败触发高清请求", async () => {
    vi.mocked(getThumbnailUrl).mockResolvedValue("asset://hd/1");
    const { container } = render(<Thumbnail assetId={1} placeholderPath="d:/t/broken.jpg" alt="a" size={512} fit="cover" />);
    const ph = container.querySelector('img[alt="a"]') as HTMLImageElement;
    expect(ph).not.toBeNull();
    // 触发占位图 onError
    ph.dispatchEvent(new Event("error"));
    await waitFor(() => expect(vi.mocked(getThumbnailUrl)).toHaveBeenCalled());
  });

  it("同一素材并发请求合并为一个（single-flight）", async () => {
    let resolveFn: (u: string) => void = () => {};
    vi.mocked(getThumbnailUrl).mockReturnValue(new Promise<string>((r) => (resolveFn = r)));
    // 两个组件请求同一 assetId+size
    render(<Thumbnail assetId={7} placeholderPath={null} alt="a" size={512} fit="cover" />);
    render(<Thumbnail assetId={7} placeholderPath={null} alt="b" size={512} fit="cover" />);
    fireVisible();
    // 只发一次底层 IPC
    expect(vi.mocked(getThumbnailUrl)).toHaveBeenCalledTimes(1);
    resolveFn("asset://hd/7");
  });
});
