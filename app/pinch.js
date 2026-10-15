/* ==========================================================================
 * 双指缩放（模仿笔记类 App 的手势）
 *
 * 对应 AR-2.0「app/pinch.js（zoom-scribe）」一节。要点：
 *
 *  1. 手势期间**冻结滚动**：给 viewer 设 overflow:hidden，只写 #pages 的
 *     transform。绝对不在 touchmove 里改 scrollLeft/scrollTop —— 旧实现
 *     （app.js:856-916）一边改滚动一边改 transform，两者数学上互相打架，
 *     正是「中心点不准 + 抖动 + 页面外缩放剧烈滚动」的根源。
 *  2. transformOrigin 固定 '0 0'，transform = translate(tx,ty) scale(k)；
 *     tx/ty 由 app/pinch-math.js 的纯函数算出，保证「起始焦点下的文档点」
 *     始终贴在当前两指中点（跟着手指走）。
 *  3. 抬手时按不变式算出新的 scrollLeft/scrollTop（焦点下的文档点不移动），
 *     再用 restoreAnchor 兜底，避免跳页。
 *  4. isActive() 给 app.js 的双击缩放做互斥：双指捏合时两根手指各自会派发
 *     pointerup，可能被 320ms 双击阈值误判。
 * ========================================================================== */

import {
  previewRatio,
  previewTransform,
  scrollAfterPinch,
} from './pinch-math.js';

/**
 * @param {object} opts
 * @param {HTMLElement} opts.viewer 滚动容器（#viewer）
 * @param {HTMLElement} opts.pagesEl 页面容器（#pages），被施加 transform
 * @param {(clientY:number)=>object} opts.captureAnchorAtClientY 记录视口某点对应的页内锚点
 * @param {(anchor:object)=>void} opts.restoreAnchor 把锚点还原到视口
 * @param {()=>void} opts.applyLayout 重新布局（不换比例时用）
 * @param {(scale:number)=>void} opts.zoomTo 落到某个绝对比例
 * @param {(mode:string)=>void} [opts.setFit] AR 签名的一部分（当前手势不使用）
 * @param {()=>number} opts.getStartScale 当前比例，见 AR（state.pages[..].scale || customScale）
 * @param {()=>HTMLElement|null} opts.getZoomLabel 返回缩放百分比按钮（手势中实时更新文案）
 * @param {number} opts.SCALE_PER_PERCENT
 * @param {number} opts.ZOOM_MIN
 * @param {number} opts.ZOOM_MAX
 * @param {()=>boolean} [opts.isReady] 是否允许开始手势（默认：pagesEl 里已有页面）
 * @returns {{ isActive: () => boolean, recentlyActive: (ms?:number) => boolean, cancel: () => void }}
 */
export function installPinch({
  viewer,
  pagesEl,
  captureAnchorAtClientY,
  restoreAnchor,
  applyLayout,
  zoomTo,
  setFit,
  getStartScale,
  getZoomLabel,
  SCALE_PER_PERCENT,
  ZOOM_MIN,
  ZOOM_MAX,
  isReady,
}) {
  const minScale = ZOOM_MIN;
  const maxScale = ZOOM_MAX;

  let active = false;
  let startDist = 1;
  let scale0 = 1;
  let scroll0 = { left: 0, top: 0 };
  let focus0 = { x: 0, y: 0 };
  let focus = { x: 0, y: 0 };
  let ratio = 1;
  let prevOverflow = '';
  let lastEndAt = -1e9;

  function isEnabled() {
    if (typeof isReady === 'function') return !!isReady();
    return pagesEl.children.length > 0 && !!viewer.parentElement;
  }

  function touchDistance(t) {
    return Math.hypot(
      t[0].clientX - t[1].clientX,
      t[0].clientY - t[1].clientY,
    );
  }

  /** 两指中点，换算成相对 viewer 左上角的坐标。 */
  function focal(t) {
    const rect = viewer.getBoundingClientRect();
    return {
      x: (t[0].clientX + t[1].clientX) / 2 - rect.left,
      y: (t[0].clientY + t[1].clientY) / 2 - rect.top,
    };
  }

  function currentScroll() {
    return { left: viewer.scrollLeft, top: viewer.scrollTop };
  }

  function setZoomLabel(scale) {
    if (typeof getZoomLabel !== 'function') return;
    const node = getZoomLabel();
    if (node && typeof node === 'object' && 'textContent' in node) {
      node.textContent = Math.round(scale / SCALE_PER_PERCENT) + '%';
    }
  }

  /** 只写一次 transform（每帧一次）；不碰 scrollLeft/scrollTop。 */
  function paint() {
    const k = previewRatio(ratio, scale0, minScale, maxScale);
    const t = previewTransform(currentScroll(), focus0, focus, k);
    pagesEl.style.transformOrigin = '0 0';
    pagesEl.style.transform =
      'translate(' + t.tx + 'px, ' + t.ty + 'px) scale(' + k + ')';
    setZoomLabel(scale0 * k);
  }

  function restoreOverflow() {
    viewer.style.overflow = prevOverflow;
    viewer.classList.remove('is-pinching');
  }

  function begin(e) {
    if (active || !isEnabled()) return;
    active = true;
    ratio = 1;
    startDist = Math.max(1, touchDistance(e.touches));
    scale0 = getStartScale() || 1;
    scroll0 = currentScroll();
    focus0 = focal(e.touches);
    focus = { x: focus0.x, y: focus0.y };
    prevOverflow = viewer.style.overflow;
    viewer.style.overflow = 'hidden'; // 手势期间冻结滚动
    viewer.classList.add('is-pinching');
    pagesEl.style.transformOrigin = '0 0';
  }

  function move(e) {
    if (!active) return;
    if (e.touches.length !== 2) return;
    if (e.cancelable) e.preventDefault(); // 不让浏览器接管成滚动/系统缩放
    ratio = touchDistance(e.touches) / startDist;
    focus = focal(e.touches);
    paint();
  }

  function finish() {
    if (!active) return;
    active = false;
    lastEndAt = Date.now();

    // 锚点在「清 transform / 改布局」之前捕获：读到的还是旧布局 + 旧滚动。
    const rect = viewer.getBoundingClientRect();
    const anchorAtEnd = captureAnchorAtClientY(rect.top + focus.y);

    // 预览比例与落地比例完全一致（previewRatio 已夹到缩放上下限内）。
    const k = previewRatio(ratio, scale0, minScale, maxScale);
    const targetScale = scale0 * k;

    // 先撤预览，回到真实布局。
    pagesEl.style.transform = '';
    pagesEl.style.transformOrigin = '0 0';
    restoreOverflow();

    if (Math.abs(k - 1) > 0.02) zoomTo(targetScale);
    else applyLayout();

    // 不变式：起始焦点下的文档点 D = scroll0 + focus0 在新布局下仍落在 focus 下。
    // zoomTo() 内部是同步的（applyLayout + renderVisiblePages + saveSettings），
    // 所以这里可以立刻写滚动。
    const next = scrollAfterPinch(scroll0, focus0, focus, k);
    viewer.scrollLeft = Math.max(0, next.left);
    viewer.scrollTop = Math.max(0, next.top);

    // 兜底：按真实 DOM 锚点再校一次，抵消页边距等非线性因素。
    restoreAnchor(anchorAtEnd);
  }

  function cancel() {
    if (!active) return;
    active = false;
    lastEndAt = Date.now();
    pagesEl.style.transform = '';
    pagesEl.style.transformOrigin = '0 0';
    restoreOverflow();
    viewer.scrollLeft = scroll0.left;
    viewer.scrollTop = scroll0.top;
  }

  function onTouchStart(e) {
    if (e.touches.length !== 2) return;
    begin(e);
  }

  function onTouchEnd(e) {
    if (active && e.touches.length < 2) finish();
  }

  viewer.addEventListener('touchstart', onTouchStart, { passive: true });
  viewer.addEventListener('touchmove', move, { passive: false });
  viewer.addEventListener('touchend', onTouchEnd, { passive: true });
  viewer.addEventListener('touchcancel', finish, { passive: true });

  return {
    /** 手势进行中。给 app.js 的双击缩放做互斥。 */
    isActive() { return active; },
    /**
     * 手势刚结束的一小段时间内也为真。
     * 双指抬起时第二根手指的 pointerup 可能晚于 touchend（此时 isActive() 已是 false），
     * 若只判断 isActive() 会被 320ms 双击阈值误判 —— 双击处理里推荐：
     *   if (pinchApi.isActive() || pinchApi.recentlyActive(400)) return;
     */
    recentlyActive(ms) {
      return Date.now() - lastEndAt < (ms === undefined ? 400 : ms);
    },
    cancel,
  };
}
