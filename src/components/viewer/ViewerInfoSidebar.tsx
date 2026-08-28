/**
 * ViewerInfoSidebar（指导书 §2.3/§4.1）：查看器左属性栏。
 *  只保留 属性（通用 / 图片 / 视频分组）。标签区 FB2-04 已收敛到 ViewerViewport 下方的
 *  ViewerTagBar（同一页只保留一个编辑入口，避免双入口状态分叉，§10.3）。
 */
import AssetInfoPanel from "@/components/library/AssetInfoPanel";
import type { Asset } from "@/types/asset";

interface ViewerInfoSidebarProps {
  asset: Asset;
  onRefreshed: (asset: Asset) => void;
}

export default function ViewerInfoSidebar({ asset, onRefreshed }: ViewerInfoSidebarProps) {
  return (
    <div className="flex flex-col gap-4">
      {/* 属性（通用/图片/视频分组） */}
      <section>
        <h4 className="mb-1.5 text-[10px] font-medium tracking-wide text-[var(--color-text-secondary)] uppercase">属性</h4>
        <AssetInfoPanel asset={asset} onRefreshed={onRefreshed} />
      </section>
    </div>
  );
}