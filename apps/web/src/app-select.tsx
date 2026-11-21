import { Select } from '@base-ui/react/select'
import { ChevronRightIcon } from './icons'

export function AppSelect<Value extends string>({ container, items, label, onChange, value }: {
  container?: Select.Portal.Props['container']
  items: { label: string; value: Value }[]
  label: string
  onChange: (value: Value) => void
  value: Value
}) {
  return (
    <Select.Root items={items} value={value} onValueChange={(next) => { if (next !== null) onChange(next) }}>
      <Select.Trigger aria-label={label} className="app-select">
        <Select.Value />
        <Select.Icon className="app-select-icon"><ChevronRightIcon width={14} height={14} /></Select.Icon>
      </Select.Trigger>
      <Select.Portal container={container}>
        <Select.Positioner align="start" alignItemWithTrigger={false} className="app-select-positioner" sideOffset={6}>
          <Select.Popup className="app-select-popup" data-base-ui-swipe-ignore="">
            <Select.List>
              {items.map((item) => <Select.Item className="app-select-option" key={item.value} value={item.value}>
                <Select.ItemText>{item.label}</Select.ItemText>
                <Select.ItemIndicator aria-hidden="true">✓</Select.ItemIndicator>
              </Select.Item>)}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  )
}
