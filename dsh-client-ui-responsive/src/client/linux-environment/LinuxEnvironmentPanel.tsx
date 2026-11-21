import { IconCodeOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import { LinuxEnvironmentSection } from './LinuxEnvironmentSection.tsx'

export function LinuxPanelIcon({ size }: { size: number }) {
  return <IconCodeOutlineMedium size={size} />
}

export function LinuxEnvironmentPanel({ close }: { close(): void }) {
  return (
    <div className="dsh-linux-panel" data-dsh-linux-environment-panel="">
      <LinuxEnvironmentSection close={close} sidebar />
    </div>
  )
}
