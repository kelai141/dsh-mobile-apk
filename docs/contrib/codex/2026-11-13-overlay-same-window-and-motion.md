# 悬浮同窗取件、独立sheet与距离motion（2026-11-13）

## 现象与真因

- 旧sheet虽然已独立DRAWER，V2仍给COMPOSER加sheet高度，实际输入被抬移；“独立窗口”不等于“覆盖不避让”。
- 旧picker prepare撤card/pill/composer、返回后show重建，即使重新填回text也破坏同View/选区/焦点/草稿身份。只加NOT_TOUCHABLE也不足：Android12+会按不可信overlay合成opacity阻止下层触摸。
- 旧短pill+速度/新DOWN顶部开关不满足连续非线性形变、慢推、宽容渐淡要求；旧纯helper绿色只证明旧输入。
- 旧真实历史仅对话text，工具live摘要不能代表完整历史调用；安全Markdown不能用不可信HTML或任意payload stringify替代。

## 当前修法与边界

- [V2](<../../../app/src/main/java/com/dsharnessmobile/shell/OverlayV2.kt>)的sheet只动DRAWER自身frame，覆盖COMPOSER不抬移。输入/chips布局沿[Composer](<../../../app/src/main/java/com/dsharnessmobile/shell/OverlayComposer.kt>)。
- [Windows](<../../../app/src/main/java/com/dsharnessmobile/shell/OverlayWindows.kt>)交互租约保存原slot/View/flags/alpha，临时NOT_FOCUSABLE+NOT_TOUCHABLE并降低opacity；yield失败rollback/null，失败rollback另存pendingInteractionRestore；restore仅同View、成功才清票，失败保票，V2最多三次120ms额外重试。精确预生成sid/request先登记再launch，防同步错误及迟到回执改新窗。空sid拒绝取件不create；outside租约中早返回。visual配置不重建，但真实旋转仍可同View安全reflow，不能把frame不变误套到尺寸已变的屏幕。
- [Motion](<../../../app/src/main/java/com/dsharnessmobile/shell/OverlayMotion.kt>)无Android/时钟/速度/WM副作用，provisional参数待设备调优。card固定root跟手绘制，终态才交接长pill；topLimit当前cardTop避状态栏，宽容后距离fade，同DOWN可完成；取消/不足回弹，最终联动收底部不取消Agent。球到边只arm、再outward收条、inward复球，左右对称并consumed抑制补tap。
- [公开历史投影](<../../../dsh-client-ui-responsive/src/client/mobile/overlay-host.ts>)→[Kotlin复验](<../../../app/src/main/java/com/dsharnessmobile/shell/OverlayPageHost.kt>)→[CardView](<../../../app/src/main/java/com/dsharnessmobile/shell/OverlayCardView.kt>)分user/assistant/tool，真实call身份配对；预算和字段唯一细节见[设计§5.5](<../../overlay-refactor-2026-11/design.md>)。assistant使用[安全Markdown](<../../../app/src/main/java/com/dsharnessmobile/shell/OverlayMarkdown.kt>)native spans，user/tool literal，链接不可执行，无HTML/图片网络。顶部按钮/热区已移除，显式形态在应用设置trusted桥，共用旧偏好，不改启用与默认v2=false。

## 新命中面增量（不等设备通过）

- [Composer](<../../../app/src/main/java/com/dsharnessmobile/shell/OverlayComposer.kt>)移除fullwidth pillRow，workspace/session原稳定TextView各进有界WORKSPACE/SESSION窗；尺寸/间隙由chipSizesPx/chipGapPx提供，answer隐藏chips，位置跟随composer实际screen location/IME不为sheet避让。
- [OverlayTouchRegion](<../../../app/src/main/java/com/dsharnessmobile/shell/OverlayTouchRegion.kt>)供API33 Composer事件驱动surface union与Card变化morph真实圆角Region。apply/reset/attach/layout走绘制同源几何，整数Region+surface缓存、detach forget；公共setter内部请求traversal，现代morph变化进度可能触发框架layout，不是draw-only输入transaction。无显式历史measure/逐帧WM resize，但性能待验；低API返回false不是已覆盖。
- 最新API33真实圆角Region成功时V2不加NOT_TOUCHABLE；false才旧flag fallback。composer WM1、picker九槽.15独立。lead实机日志证实旧NOT_TOUCHABLE即使请求alpha1也被WMS强制cap至.80，源码实色/请求值不能推出实际不透底；API26–32/失败fallback视觉限制仍未解决，composer间隙与跨UID新DOWN仍须单独验。

## 物理可达与旋转落点后续修正

原基础collapse距离在空历史小卡片上可能大于handle到状态栏安全线的真实可达距离；大卡片成功不能证明最小卡片可操作，不能用负屏坐标绕过。冻结实现改用[OverlayMotionConfig.feasibleCollapseDistancePx](<../../../app/src/main/java/com/dsharnessmobile/shell/OverlayMotion.kt>)的handle TOP保守预算（不是中心），参数非法/非正travel回null，不制造最小距离；[V2](<../../../app/src/main/java/com/dsharnessmobile/shell/OverlayV2.kt>)DOWN测量锁定MOVE/UP/settle，取消/hide/终态清理。公式及无有效测量时仍用base的实际回退见[架构](<../../AGENTS/ARCHITECTURE.md>)，fallback不当正屏可达证明；84dp/.8不是确认产品门。

chips先前只看layout通知会漏旋转后系统pan的最终screen坐标；冻结实现attach/detach对称GL/PreDraw与guarded post、单View lifetime layout监听，chip尺寸先按width/labels/density/fontScale查cache，actual top先规范化再比较/写回，几何不变不提交WM，防紧凑横屏更新环；lease-first守住chip/drawer membership。排队focus在V2 main.post与Composer input.post/showSoftInput前复查同identity/generation/lifecycle/picker，防系统取件被迟到键盘抢焦。这与sheet抬移避让不同；空卡/横竖旋转/真实IME落点仍按最终输入设备复验，不从源码修正推出已通过。

## 用户截图重合后的视觉修正（待设备前后图）

用户指出“图片有重合”，lead复读实际截图确认两种真缺陷：card morph旧status/history/handle与新capsule同位显示；sheet/input半透明叠出下层文字与原发送/chips。旧SCOPED_PASS只是驱动断言范围，不能忽略用户视觉事实或提升成UI acceptance。

当前[OverlayCardMorphVisual](<../../../app/src/main/java/com/dsharnessmobile/shell/OverlayCardMorphVisual.kt>)纯helper将旧层smoothstep在0..0.3退尽，新单行从0.5后进入，非同时文字crossfade；卡片/长pill/input/sheet/ScrollView为实色ds_surface，chips/附件tiles为实色ds_chip，保finite进退场alpha而非静态半透明阅读。此前尝试WM常态composer及morph原alpha1后，新的设备图仍透Gallery；lead WMS日志确认NOT_TOUCHABLE被系统强制cap.80，这是已证真因，不是Paint共享假设。最新Card真实圆角Region成功不加该flag，false才旧fallback；fill/border/dot独立Paint+alpha255只是防御，不冒充根因修复证据。旧API/失败fallback仍有视觉限制，取件.15独立，gap透传不称已好。screen改ignoringVisibility系统栏稳定预算，配置变化重注drawer40% cap/sync并post实际chip几何，sheet min-cover含composer+chip+gap+24dp后钳40%防半截chip；图像/触摸/旋转各自验证，源码修正不算通过。

## 复验与证据边界

**CURRENT VERIFICATION PENDING。未做设备验证、未跑Gradle、未build/install：本记录作者仅核读源码并同步文档。**

文档分工实际执行：node scripts/check-code-map.mjs，首轮exit1（新OverlayMarkdown/OverlayMotion未登记、旧bridge/service/settings锚点漂移）；在[执行地图](<../../AGENTS/EXECUTION-MAP.md>)逐项补coverage并移动到已审阅符号/显式expect，不改脚本/基线或删判据。后续新OverlayTouchRegion显式登记及移动Service/架构锚点后最终门禁exit0；check-code-map --self-test、node scripts/check-bridge-symmetry.mjs及git diff --check亦exit0。地图/桥门禁只证明登记与接口，不能推导功能、设备或性能通过。

当前代码/前端/装机/外部设备包被替换等时序只由lead的[测试报告](<../../overlay-refactor-2026-11/test-report-phase2.md>)维护；不复制测试数字，不把不同输入/全量与专项拼成新全量。实际两向sheet frame、三类取件同View原稿、慢推顶缘/边滑、终态形变交接、长稳CPU/PSS/帧时、低API与最终同源APK均须各自证据，不能从源码存在推出已完成。
