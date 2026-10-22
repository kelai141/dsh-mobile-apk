/**
 * Developer-options settings-page styles: reuse --dsw-* semantic tokens (auto light/dark), buttons in
 * a wrapping row layout; on narrow screens (mobile form) buttons become a two-column grid.
 * Injection matches mobile-settings.css.ts (style tag + data-plugin attribute; this page's root
 * selector uses [data-plugin='dev-section'] against class-hash churn).
 */
export const DEV_SECTION_CSS: string = `
[data-plugin='dev-section'] {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 0 12px;
}

.dsh-dev-note {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
  /* 设备绝对路径（设置页会显示导出/缓存目录）是不可断的长串：手机宽度下会把内容列撑到横向溢出。
     取 anywhere 而不是 break-word——只有前者会把 min-content 一起算进去，flex 列里才真正收窄。 */
  overflow-wrap: anywhere;
}

.dsh-dev-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

/* 并列半行宽按钮行（0.14.1 Shizuku 引导：左「下载」右「打开」）。
 * 两侧等宽平分（flex: 1 1 0），窄屏 media query 里的 calc(50% - 5px) 被这条的
 * 更高优先级覆盖——用户定例是「无论宽窄都并列半行」。
 * 高度单列抬高到 44px：这两个按钮是「跳出去办一件事」，比本页其余按钮更需要点得准。 */
.dsh-dev-split > .dsh-dev-btn {
  flex: 1 1 0;
  min-height: 44px;
  text-align: center;
}

/* 文字链（0.14.1：蓝色下划线的「点击查看教程」）。
 * 用 button 而非 a[href]：跳转由壳侧发起（外部浏览器），页面不导航；
 * button 天然可键盘聚焦、可回车触发，且不会出现「点了页面自己跳走」。
 * 颜色写显式品牌蓝，**不取 --dsw-alias-brand-primary**——该 token 深色主题下实测近白
 * （与 reference-menu.ts 同一处理），会变成白底白字。 */
.dsh-dev-link {
  min-height: 40px;
  padding: 8px 2px;
  border: none;
  background: none;
  color: #4d6bfe;
  font-size: 13px;
  line-height: 20px;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}

.dsh-dev-btn {
  min-height: 36px;
  padding: 6px 14px;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 8px;
  background: var(--dsw-alias-button-elevated-fill);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
}

.dsh-dev-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

/* Language mode choices: three buttons in one row, the active one filled. */
.dsh-dev-lang-choices {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
}

.dsh-dev-btn-active {
  border-color: var(--dsw-alias-state-success-primary, var(--dsw-alias-border-l3));
  background: var(--dsw-alias-state-success-primary, var(--dsw-alias-button-elevated-fill));
  color: var(--dsw-alias-label-primary-inverted);
}

.dsh-dev-danger {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
}

.dsh-dev-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  padding: calc(20px + var(--dsh-mobile-top-inset, 0px)) 20px 20px;
}

.dsh-dev-modal {
  width: 100%;
  max-width: 360px;
  padding: 18px 20px;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-elevation-prominent);
}

.dsh-dev-modal-title {
  margin: 0 0 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}

.dsh-dev-modal-desc {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}

.dsh-dev-modal-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}

.dsh-dev-switch {
  font-size: 14px;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
}

.dsh-dev-switch input {
  width: 16px;
  height: 16px;
  margin: 0;
}

.dsh-screen-scope-row {
  justify-content: space-between;
  padding: 10px 0;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.dsh-screen-scope-row > span {
  display: grid;
  gap: 4px;
  min-width: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
}
.dsh-screen-scope-row small {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.dsh-screen-scope-row select {
  min-height: 34px;
  max-width: min(100%, 190px);
  padding: 0 28px 0 10px;
  border: 1px solid var(--dsw-alias-border-l4);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: inherit;
}

.dsh-screen-control-card {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2);
}
.dsh-screen-control-header {
  display: flex;
  gap: 10px;
  justify-content: space-between;
  align-items: flex-start;
}
.dsh-screen-control-header > span:first-child {
  display: grid;
  gap: 4px;
  min-width: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
}
.dsh-screen-control-header small {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.dsh-screen-control-state {
  flex: 0 0 auto;
  padding: 3px 8px;
  border: 1px solid var(--dsw-alias-border-l4);
  border-radius: 999px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.dsh-screen-control-state[data-state='ready'],
.dsh-screen-control-state[data-state='active'] {
  border-color: var(--dsw-alias-link);
  color: var(--dsw-alias-link);
}
.dsh-screen-control-detail {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.dsh-screen-control-detail strong { color: var(--dsw-alias-label-primary); }

.dsh-root-access-card {
  display: grid;
  gap: 14px;
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2);
}
.dsh-root-access-card p { margin: 0; overflow-wrap: anywhere; }
.dsh-root-access-card .dsh-screen-control-state { max-width: 45%; text-align: center; }
.dsh-root-step { display: grid; gap: 8px; min-width: 0; }
.dsh-root-step + .dsh-root-step { padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-l2); }
.dsh-root-access-card .dsh-dev-btn { min-height: 44px; width: 100%; }
.dsh-root-access-card .dsh-dev-link { min-height: 44px; justify-self: start; text-align: left; }
.dsh-root-toggle-row { display: flex; align-items: center; gap: 14px; min-height: 44px; }
.dsh-root-toggle-row > span { flex: 1 1 auto; }
.dsh-root-toggle-row > input { flex: 0 0 auto; width: 24px; height: 24px; margin: 0; accent-color: #4d6bfe; }
.dsh-root-maintenance { padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l2); }
.dsh-root-maintenance summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; color: var(--dsw-alias-label-primary); }
.dsh-root-maintenance[open] { display: grid; gap: 8px; }
.dsh-root-access-card button:focus-visible,
.dsh-root-access-card input:focus-visible,
.dsh-root-maintenance summary:focus-visible { outline: 2px solid #4d6bfe; outline-offset: 3px; }
@media (min-width: 640px) {
  .dsh-root-access-card .dsh-dev-btn { width: auto; justify-self: start; min-width: 160px; }
}

.dsh-dev-error {
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 18px;
}

.dsh-dev-label {
  font-size: 14px;
  color: var(--dsw-alias-label-primary);
  min-width: 64px;
}

.dsh-dev-value {
  font-size: 13px;
  color: var(--dsw-alias-label-secondary);
  min-width: 44px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.dsh-dev-row input[type='range'] {
  flex: 1;
  min-width: 120px;
}

.dsh-dev-hint {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  /* 同上：导出路径、缓存目录等长串必须能断行（设备实测 412px 下无此规则会横向溢出）。 */
  overflow-wrap: anywhere;
}

/* issue #471：启动失败诊断（可展开的子进程堆栈）。 */
.dsh-dev-diag {
  margin: 2px 0 8px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-dev-diag summary {
  min-height: 32px;
  display: flex;
  align-items: center;
  cursor: pointer;
}
.dsh-dev-diag pre {
  margin: 6px 0 0;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 11px;
  line-height: 1.45;
}

.dsh-dev-warn {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-error-primary);
  /* 错误文案会带回壳侧原文（可能含路径），同样需要断行。 */
  overflow-wrap: anywhere;
}

/* 0.14.1 块 E：运行时缓存清理块（清单行 + 跳过明细折叠）。标签一律为
 * $DSH_HOME/$DSH_FILES_DIR 形态，绝不出现应用私有目录的绝对路径。 */
.dsh-dev-cache {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2);
}

.dsh-dev-cache-list {
  margin: 0;
  padding-left: 18px;
  max-height: 180px;
  overflow: auto;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  word-break: break-all;
}

/* 0.14.1 块J FIX-4：通知设置块（前台抑制 + 五类分类开关）。 */
.dsh-dev-notify {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2);
}

.dsh-dev-notify-cats {
  display: grid;
  gap: 4px;
}

/* 每个分类开关 + 它的「关掉会怎样」说明（批 4 / P0-5：纯标签开关会让用户按旧语义做决定）。 */
.dsh-dev-notify-cat {
  display: grid;
  gap: 2px;
  padding: 4px 0;
}

.dsh-dev-notify-cat .dsh-dev-hint {
  margin: 0 0 0 2px;
}

/* #43 深色兜底（2026-08-18 首修 / 2026-09-25 二次修）。
 *
 * 首修把这一块挂在 @media (prefers-color-scheme: dark)：本机实测三个 prefers-color-scheme
 * 查询（dark/light/no-preference）全为 false，所以那块兜底从未生效。主题真源是
 * body[data-ds-dark-theme]（壳侧另写 html[data-ds-theme-source]='dark'），上游
 * design-platform.css 自己的深色令牌表也挂这个选择器 —— 故本节改挂同一选择器。
 *
 * 上方基础规则已全部改用本代存在的自适应令牌（label-primary / label-secondary /
 * bg-layer-2 / border-l3 / button-elevated-fill / state-error-primary），亮暗两套取值由上游
 * 按主题各自定义。因此本节在正常宿主下不改变任何取值，只在整张令牌表缺席的宿主
 * （非 Android WebView、无 dsh 主题表）里兜住深色：回退值一律取深色，绝不再退回
 * #fff/#ccc 这类亮色硬编码，否则就是 #43 的白底白字复发。 */
body[data-ds-dark-theme] .dsh-dev-btn,
body[data-ds-dark-theme] .dsh-dev-modal {
  background: var(--dsw-alias-bg-layer-2, #26262b);
  border-color: var(--dsw-alias-border-l3, #3a3a42);
}
body[data-ds-dark-theme] .dsh-dev-warn,
body[data-ds-dark-theme] .dsh-dev-danger,
body[data-ds-dark-theme] .dsh-dev-error {
  border-color: var(--dsw-alias-state-error-primary, #f25a5a);
  color: var(--dsw-alias-state-error-primary, #f25a5a);
}

@media (max-width: 639px) {
  .dsh-dev-btn {
    flex: 1 1 calc(50% - 5px);
    text-align: center;
  }
}

/* 通知自检面（批 4）：每渠道一行「系统实际状态 + 直达系统设置」——此前这条信息零调用点。 */
.dsh-dev-notify-check {
  display: grid;
  gap: 4px;
  margin-top: 8px;
}

.dsh-dev-check-row {
  align-items: center;
  gap: 8px;
}
`
