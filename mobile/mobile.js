/* 移动端运行时补丁 —— 由 build-mobile.ps1 追加到 index.js 末尾
 * 作用：把软键盘（visualViewport）遮挡的高度写进 --tam-keyboard，
 * 让悬浮窗和弹层自动抬到键盘上方。
 */
(function () {
  'use strict';

  const vv = window.visualViewport;
  if (!vv) return;

  let frame = 0;

  function apply() {
    frame = 0;
    const root = document.getElementById('tam-root');
    if (!root) return;
    const scale = Number(vv.scale) || 1;
    // iOS 横屏/双指缩放时 offsetTop/scale 会让裸差值偏大；再封顶，避免面板被顶出屏幕
    const raw = window.innerHeight - vv.height * scale - vv.offsetTop;
    const inset = Math.max(0, Math.min(Math.round(window.innerHeight * 0.6), Math.round(raw)));
    root.style.setProperty('--tam-keyboard', inset + 'px');
  }

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(apply);
  }

  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  window.addEventListener('orientationchange', () => setTimeout(schedule, 200));
  window.addEventListener('focusin', schedule);
  window.addEventListener('focusout', schedule);
  schedule();
})();
