import { Button, IconCodeOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import { tr } from '../i18n.ts'
import { LinuxEnvironmentSection } from './LinuxEnvironmentSection.tsx'

export function LinuxPanelIcon({ size }: { size: number }) {
  return <IconCodeOutlineMedium size={size} />
}

export function LinuxEnvironmentPanel({ close }: { close(): void }) {
  return (
    <div className="dsh-linux-panel">
      <header className="dsh-linux-panel-header">
        <Button size="sm" variant="outline" onClick={close}>{tr('返回', 'Back')}</Button>
        <h1>{tr('Linux 环境', 'Linux environment')}</h1>
      </header>
      <LinuxEnvironmentSection close={close} />
    </div>
  )
}
