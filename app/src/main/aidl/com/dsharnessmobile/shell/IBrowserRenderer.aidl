// BrowserHost 兼容档（process-suffix）的远端渲染器契约。
// 主进程 BrowserHost 保留全部模型/策略/页面脚本；本接口只暴露视图原语。
// 语义与实锤依据：docs/BROWSER-COMPAT-SPIKE-2026-10-24.md。
package com.dsharnessmobile.shell;

import android.os.ParcelFileDescriptor;
import com.dsharnessmobile.shell.IBrowserRendererCallback;
import android.view.SurfaceControlViewHost.SurfacePackage;

interface IBrowserRenderer {
  // 进程自证（JSON：processName/suffixApplied/sdkInt）。幂等；必须最先调。
  // configJson: {allowAnonymousEngineAccess:bool}；回调经此注册。
  String start(IBrowserRendererCallback cb, String configJson);
  // 建/复用一个 tab 的远端 WebView + SCVH。hostToken=宿主窗口 token（spike 实锤：
  // 不传则 setView 撞 INTERNAL_SYSTEM_WINDOW）。configJson: {widthPx,heightPx,
  // identityId,ua,viewportCssWidth,allowAnonymousEngineAccess}。回 JSON {ok|reason}；
  // SurfacePackage 经回调 onSurfacePackage 异步交付。
  String ensureTab(String tabId, in IBinder hostToken, String configJson);
  String destroyTab(String tabId);
  void destroyAll();
  // 导航（URL 已由主进程过 BrowserHostNavigationPolicy 规范化后传入）。
  String loadUrl(String tabId, String url);
  String reload(String tabId);
  String goBack(String tabId);
  String goForward(String tabId);
  // 舞台几何变化：重建 SCVH（WebView 保留）。spike 实锤：页面 innerWidth 可能不跟随，
  // 主进程在大幅变化时用 destroyTab+ensureTab+loadUrl 走 recycle 语义。
  String relayout(String tabId, int widthPx, int heightPx);
  // 视图原语（主进程跑 ref 解析脚本，坐标已换算成远端视图坐标）。
  boolean evaluateJs(String tabId, String script, int seq);
  boolean dispatchTap(String tabId, float x, float y);
  boolean dispatchKey(String tabId, int keyCode);
  // MotionEvent 不在 SDK framework.aidl 清单里，无法直接过 AIDL——传标量字段、远端重建。
  // 单指手势（点按/拖动/滚动）足够；多指批量留待接线 PR 按需扩展。
  //
  // 本方法是每帧触摸路径（一次滑动 20 余条事件），故为 oneway：
  //  - 返回值语义丢失：调用方拿不到「远端是否消费」，触摸回调恒按已消费处理
  //    （否则丢一次 MOVE 就会被系统当成手势结束）；投递结果不计入任何 UI 线程。
  //  - 主进程主线程只做一次非阻塞 Binder 投递，不再等待渲染进程主线程。
  //  - 渲染侧负责合帧（MotionCoalescer）：DOWN/UP/CANCEL 保序、连续 MOVE 只留最后一条。
  // dispatchTap / dispatchKey 刻意保持同步 boolean：它们是一次性工具调用，返回值要如实
  // 报给模型，且不在每帧触摸路径上。
  oneway void forwardMotion(String tabId, int action, long downTime, long eventTime,
      float x, float y, float pressure, float size, int metaState);
  // 截图：PNG 写入给定 fd（主进程建管道读）。
  boolean capture(String tabId, in ParcelFileDescriptor fd, int maxWidthPx, int maxHeightPx);
  // 状态快照（JSON：url/title/loadState/reason/generation/width/height/scrollY/
  // scrollDirection/canGoBack/canGoForward/blockedRequests）。
  String tabState(String tabId);
  String tabIds();
  // 数据面（进程级单例，作用于后缀档案）。
  String flushCookies();
  String clearBrowsingData();
}
