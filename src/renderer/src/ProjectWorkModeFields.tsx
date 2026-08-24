import type { WorkMode } from '../../shared/assistant-contracts'
import { SegmentedControl } from './WorkspacePrimitives'

export function ProjectWorkModeFields({
  ariaLabel,
  disabled = false,
  help,
  labels,
  legend,
  onChange,
  value
}: {
  ariaLabel: string
  disabled?: boolean
  help?: string
  labels: { ask: string; execute: string }
  legend: string
  onChange: (value: WorkMode) => void
  value: WorkMode
}): React.JSX.Element {
  return (
    <fieldset className="project-work-mode">
      <legend>{legend}</legend>
      <SegmentedControl
        ariaLabel={ariaLabel}
        disabled={disabled}
        onChange={onChange}
        options={[
          { value: 'ask', label: labels.ask },
          { value: 'execute', label: labels.execute }
        ]}
        value={value}
      />
      {help && <small>{help}</small>}
    </fieldset>
  )
}
