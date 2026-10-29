// issue #864：控制台布局量测上报（**只存在于 debug 变体**）。
//
// 为什么走这里而不是 CDP：本机 CDP 的 HTTP 面正常（/json/version 返回 Chrome/110 + Protocol 1.3），
// 但 WebSocket 连 101 都收不到（HTTP 通 / WS 不通），六值量不出来。
// 页面把数值打到 console，壳侧 onConsoleMessage 复用既有 boot-diag 通道落盘，
// 用 `adb shell run-as com.dsharnessmobile.shell cat files/boot-diag.log` 直接读。
//
// 只报六项布局数值：--ime-occlusion / --inset-bottom / innerHeight /
// visualViewport.height / data-console-compact / dpr。
// **不含任何路径、凭据或页面内容。**
(function () {
  if (window.__dshConsoleMetrics) return;
  window.__dshConsoleMetrics = true;
  function emit(tag) {
    var cs = getComputedStyle(document.documentElement);
    console.log('[dsh-console-metrics] ' + JSON.stringify({
      tag: tag,
      imeOcclusion: cs.getPropertyValue('--ime-occlusion').trim(),
      insetBottom: cs.getPropertyValue('--inset-bottom').trim(),
      innerHeight: window.innerHeight,
      visualViewportHeight: window.visualViewport ? Math.round(window.visualViewport.height) : -1,
      compact: document.documentElement.hasAttribute('data-console-compact'),
      dpr: window.devicePixelRatio
    }));
  }
  emit('load');
  window.addEventListener('resize', function () { emit('resize'); });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', function () { emit('vv-resize'); });
})();