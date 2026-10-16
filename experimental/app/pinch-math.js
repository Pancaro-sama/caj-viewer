/* ==========================================================================
 * 双指缩放的纯几何数学 —— 无 DOM、无副作用，便于 tests/pinch-math.test.mjs 自测。
 *
 * 坐标约定
 *   d : 文档坐标（#pages 里 offsetTop / offsetLeft 那一套，0 = 内容原点）
 *   p : 视口坐标（相对 viewer 左上角，例如 clientX - rect.left）
 *   s : viewer.scrollLeft / viewer.scrollTop（内容 → 视口的平移量）
 *   滚动时内容的视口位置：   p = d - s
 *
 * 手势预览（transformOrigin: '0 0'，只写 transform，不动滚动）
 *   p = tx + k * d - s
 * 手势开始时两指中点的视口坐标是 f0，其下的文档点 D = s0 + f0。
 * 手势期间要让 D 一直贴在当前两指中点 f 下：
 *   f = tx + k * D - s     =>    tx = f + s - k * D
 * 这就是 AR-2.0 里
 *   translate(f.x - k*(scroll0.left + f0.x), f.y - k*(scroll0.top + f0.y)) scale(k)
 * 的完整形式：把「焦点」换成内容坐标 f + s，scroll0 + f0 就是 D。
 *
 * 抬手后：transform 清空，页面按新比例 k 重新布局（线性近似：旧文档坐标 d → 新坐标 k*d），
 * 此时 p = k * d - scrollNew。要让 D 仍落在抬手焦点 f 下：
 *   f = k * D - scrollNew   =>    scrollNew = k * D - f
 *
 * 注意：AR-2.0 第 64-70 行的结束滚动量是伪码（它自己也标注「不要照抄」），
 * 这里按上面推平后的不变式实现，即「焦点下的文档点在手势前后不移动」。
 * ========================================================================== */

/** 通用夹取。 */
export function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

/** 把目标比例夹进 [minScale, maxScale]。 */
export function clampScale(scale, minScale, maxScale) {
  return clamp(scale, minScale, maxScale);
}

/**
 * 预览用的缩放比。
 * raw = 当前两指距离 / 起始两指距离；夹取后保证 scale0 * k 不越过
 * ZOOM_MIN / ZOOM_MAX —— 这样抬手时「预览比例」与「真正落地的比例」
 * 完全相同，松手不会因为夹取而跳一下。
 */
export function previewRatio(raw, scale0, minScale, maxScale) {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const base = scale0 > 0 ? scale0 : 1;
  return clamp(raw, minScale / base, maxScale / base);
}

/**
 * 预览 transform 的平移量。
 * @param {{left:number, top:number}} scroll 当前「实际」滚动值（正常等于手势开始时的值，
 *        浏览器若因内容缩小而钳住滚动，读当前值仍能保证焦点贴在手指下）
 * @param {{x:number, y:number}} focus0 起始两指中点（视口坐标）
 * @param {{x:number, y:number}} focus  当前两指中点（视口坐标）
 * @param {number} k 预览缩放比
 * @returns {{tx:number, ty:number}}
 */
export function previewTransform(scroll, focus0, focus, k) {
  return {
    tx: focus.x + scroll.left - k * (scroll.left + focus0.x),
    ty: focus.y + scroll.top - k * (scroll.top + focus0.y),
  };
}

/** 起始焦点下的文档点 D = scroll0 + focus0。 */
export function focusDocPoint(scroll0, focus0) {
  return { x: scroll0.left + focus0.x, y: scroll0.top + focus0.y };
}

/**
 * 抬手后应写回的滚动量，保证 D = scroll0 + focus0 在新布局下仍落在抬手焦点 focus 下。
 * k 是「真正生效」的比例（已考虑 ZOOM_MIN/ZOOM_MAX 夹取）。
 *
 * 写成 `scroll0 + (focus0 - focus) + (k - 1) * D` 而不是 `k * D - focus`，
 * 是为了让 k = 1 且 focal 未动时结果**逐位相等**于 scroll0（浮点恒等）。
 */
export function scrollAfterPinch(scroll0, focus0, focus, k) {
  const d = focusDocPoint(scroll0, focus0);
  return {
    left: scroll0.left + (focus0.x - focus.x) + (k - 1) * d.x,
    top: scroll0.top + (focus0.y - focus.y) + (k - 1) * d.y,
  };
}

/** 预览期把文档点投影到视口：p = tx + k*d - s（单轴）。 */
export function projectPreview(transform, k, docPoint, scroll) {
  return {
    x: transform.tx + k * docPoint.x - scroll.left,
    y: transform.ty + k * docPoint.y - scroll.top,
  };
}

/** 布局后把文档点投影到视口：p = k*d - scrollNew（单轴，线性近似）。 */
export function projectLayout(k, docPoint, scrollNew) {
  return {
    x: k * docPoint.x - scrollNew.left,
    y: k * docPoint.y - scrollNew.top,
  };
}
