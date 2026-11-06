/**
 * 「Linux环境」设置分区样式：只复用壳侧已有的语义令牌与 `.dsh-dev-btn` 按钮骨架
 * （由 dev-section 样式表提供），本表只补布局与状态色。
 */
export const LINUX_ENVIRONMENT_CSS: string = `
[data-plugin='linux-environment'] {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 0 12px;
}

.dsh-linux-env-header > span {
  display: grid;
  gap: 4px;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
}

.dsh-linux-env-header small,
.dsh-linux-env-hint,
.dsh-linux-env-status,
.dsh-linux-env-progress {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}

.dsh-linux-env-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}

.dsh-linux-env-row select {
  min-height: 34px;
  padding: 0 28px 0 10px;
  border: 1px solid var(--dsw-alias-border-l4);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: inherit;
}

.dsh-linux-env-check {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}

.dsh-linux-env-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.dsh-linux-env-error {
  display: grid;
  gap: 8px;
  justify-items: start;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 18px;
}

.dsh-linux-env-error p {
  margin: 0;
  overflow-wrap: anywhere;
}

.dsh-linux-env[data-phase='failed'] .dsh-linux-env-status {
  color: var(--dsw-alias-label-primary);
}

.dsh-linux-env[data-installed='true'] .dsh-linux-env-status {
  color: var(--dsw-alias-link);
}
`
