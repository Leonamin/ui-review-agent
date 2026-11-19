import { useId } from "react";
import { Select as RSelect } from "radix-ui";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import type { Option } from "./types";

export function Select({
  label,
  value,
  onValueChange,
  options,
  isDisabled = false,
  shouldShowLabelInTrigger = false,
  placeholder = "선택하세요",
  contentClassName,
  triggerClassName,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: Option[];
  isDisabled?: boolean;
  shouldShowLabelInTrigger?: boolean;
  placeholder?: string;
  contentClassName?: string;
  triggerClassName?: string;
}) {
  const id = useId();
  return (
    <div className="gc-overlay-field">
      <label id={id}>{label}</label>
      <RSelect.Root
        value={value}
        onValueChange={onValueChange}
        disabled={isDisabled}
      >
        <RSelect.Trigger className={["gc-select", triggerClassName].filter(Boolean).join(" ")} aria-labelledby={id}>
          <RSelect.Value placeholder={placeholder}>
            {shouldShowLabelInTrigger ? label : undefined}
          </RSelect.Value>
          <RSelect.Icon>
            <ChevronDown size={16} />
          </RSelect.Icon>
        </RSelect.Trigger>
        <RSelect.Portal>
          <RSelect.Content
            className={["gc-floating", "gc-select-content", contentClassName].filter(Boolean).join(" ")}
            position="popper"
            sideOffset={6}
          >
            <RSelect.ScrollUpButton className="gc-select-scroll">
              <ChevronUp size={16} aria-hidden="true" />
            </RSelect.ScrollUpButton>
            <RSelect.Viewport>
              {options.map((option) => (
                <RSelect.Item
                  className="gc-option"
                  data-value={option.value}
                  key={option.value}
                  value={option.value}
                  textValue={option.label}
                  disabled={option.isDisabled}
                >
                  <RSelect.ItemText>
                    {option.description ? (
                      <>
                        <span className="gc-option-label" title={option.label}>{option.label}</span>
                        <span className="gc-option-description">{option.description}</span>
                      </>
                    ) : option.label}
                  </RSelect.ItemText>
                  <RSelect.ItemIndicator>
                    <Check size={15} />
                  </RSelect.ItemIndicator>
                </RSelect.Item>
              ))}
            </RSelect.Viewport>
            <RSelect.ScrollDownButton className="gc-select-scroll">
              <ChevronDown size={16} aria-hidden="true" />
            </RSelect.ScrollDownButton>
          </RSelect.Content>
        </RSelect.Portal>
      </RSelect.Root>
    </div>
  );
}
