import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface Option {
  value: string
  label: string
}

interface OptionSelectProps {
  options: Option[]
  value?: string
  onChange?: (value: string) => void
  placeholder?: string
  className?: string
  disabled?: boolean
}

// Radix reserves the empty string for clearing a selection, while several
// XControl forms use it as a real "none" option.
const EMPTY_VALUE = '__xcontrol_empty_value__'

export function OptionSelect({
  options,
  value,
  onChange,
  placeholder = '请选择',
  className,
  disabled,
}: OptionSelectProps) {
  const radixValue = value === '' ? EMPTY_VALUE : value

  return (
    <div className={className}>
      <Select
        value={radixValue}
        onValueChange={(nextValue) => onChange?.(nextValue === EMPTY_VALUE ? '' : nextValue)}
        disabled={disabled}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem
              key={option.value || EMPTY_VALUE}
              value={option.value || EMPTY_VALUE}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
