/**
 * FB2-01 缩略图请求尺寸随格子档位分级（§9.3）：
 * 分级而非连续，保证 thumbnailCache 键（assetId:kind:size）收敛到少数几个值，缓存命中率接近 100%。
 *
 * 视频封面注意：后端视频 hd 封面文件名固定为 {id}_cover.jpg，尺寸不参与缓存键（thumbnail.rs:150），
 * 先到的尺寸决定内容。给大格子请求 1024 时视频封面不会变清晰（仍返回先前的 512 文件）。
 * 本轮接受此限制不改后端缓存键（改键会让存量封面失效并触发全库重抽帧，代价远大于收益）。
 */
export function thumbSizeForCell(cellPx: number): 512 | 1024 {
  return cellPx <= 190 ? 512 : 1024;
}