/**
 * 全局唯一视频播放槽（FB2-03）：同一时刻最多 1 个 hover 预览 <video> 在播。
 * 入库页与素材库共用同一槽 —— 两页可能同时挂载（超级搜索里打开 Viewer 时素材库还在后台），
 * 各持一个槽会让内存与解码器占用翻倍。
 */
let activeSlot: { key: string; pause: () => void } | null = null;

/**
 * 占用视频槽。返回释放函数。
 * @param key 唯一槽键（如 assetId）；同一 key 重复占用视为幂等，不抢占。
 * @param pause 让被抢占方停下播放（pause + 让出）的回调。
 */
export function acquireVideoSlot(key: string, pause: () => void): () => void {
  // 同一键重复占用：幂等，仅更新暂停回调
  if (activeSlot?.key === key) {
    activeSlot = { key, pause };
  } else {
    // 抢占旧的：让旧播放器 halt（pause + 清 src）
    activeSlot?.pause();
    activeSlot = { key, pause };
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (activeSlot?.key === key) activeSlot = null;
  };
}