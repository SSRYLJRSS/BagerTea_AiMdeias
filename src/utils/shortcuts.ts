/**
 * FB3-05（§7.2）：快捷键与缩放常量的唯一声明点。
 *
 * 现状约定（集中在此，改键只改这里）：
 *  - 作用域优先级：modal > player > viewer > page > global（执行方用 stopPropagation/
 *    isInsidePlayer 实现物理隔离，不走全局分发器）；
 *  - 输入框/select/textarea/contentEditable 与打开的菜单不接收页面快捷键（isEditableTarget）；
 *  - 播放器根节点（[data-player-root]）内的按键优先于页面切片（isInsidePlayer）。
 *
 * 本模块只放声明与纯函数，不绑定监听 —— 各组件的绑定位置见 SHORTCUTS 注释。
 */

/** 图片缩放范围：20%–800%（MediaViewport clampScale 使用，viewportMath.ZOOM_MIN/MAX 同源语义） */
export const IMAGE_ZOOM_MIN = 0.2;
export const IMAGE_ZOOM_MAX = 8;
/** Alt+滚轮每档缩放步进（几何级数） */
export const WHEEL_ZOOM_STEP = 1.15;
/** 双击缩放档位 */
export const DOUBLE_CLICK_ZOOM = 2;
/** 拖拽（scale>1 平移）与双击的按钮 */
export const PAN_BUTTONS = new Set([0, 1]); // 左键（放大后平移）+ 中键（兼容平移）

/** 页面级快捷键的目标是否为可编辑元素（不响应快捷键） */
export function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  return el.isContentEditable === true;
}

/** 焦点是否在播放器根节点或其子节点（player 作用域优先于 viewer/page） */
export function isInsidePlayer(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el?.closest?.("[data-player-root]");
}

/**
 * Escape 优先级（FB3-04 §6.2⑥）：浏览器全屏（任意层级）> 关闭查看器。
 * 用 document.fullscreenElement 判断而非组件状态 —— 同时覆盖查看器级全屏与播放器级全屏，
 * 避免播放器全屏时 Esc 误关整个查看器。系统退出全屏会触发 fullscreenchange 同步状态。
 */
export function escapeShouldExitFullscreen(doc: Document = document): boolean {
  return Boolean(doc.fullscreenElement);
}

/** requestFullscreen 的安全封装：环境不支持/rejected 时回落应用内全屏（不抛页面级错误） */
export async function requestFullscreenSafe(el: HTMLElement | null): Promise<boolean> {
  try {
    if (!el?.requestFullscreen) return false;
    await el.requestFullscreen();
    return true;
  } catch {
    // WebView2 权限拒绝/不可用时退化为应用内 data-viewer-fullscreen CSS 状态
    return false;
  }
}
