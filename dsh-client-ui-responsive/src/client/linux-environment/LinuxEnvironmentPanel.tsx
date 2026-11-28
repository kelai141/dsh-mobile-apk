import { LinuxEnvironmentSection, type LinuxEnvironmentSectionProps } from './LinuxEnvironmentSection.tsx'

export { LinuxEnvironmentSection }

export function LinuxEnvironmentPanel(props: Omit<LinuxEnvironmentSectionProps, 'sidebar'>) {
  return (
    <div className="dsh-linux-panel" data-dsh-linux-environment-panel="">
      <LinuxEnvironmentSection {...props} sidebar />
    </div>
  )
}
