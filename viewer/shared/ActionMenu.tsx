import { useRef, type MouseEventHandler, type Ref } from "react";
import { ChevronDown } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { Button } from "./goodcase/components/basic/button";

type Item = {
  label: string;
  description?: string;
  isDestructive?: boolean;
  hasSeparatorBefore?: boolean;
} & (
  | { onSelect: () => void }
  | { href: string; onClick?: MouseEventHandler<HTMLAnchorElement> }
);

export function ActionMenu({
  label,
  items,
  variant = "default",
  triggerRef,
  shouldRestoreFocusOnSelect = true,
}: {
  label: string;
  items: Item[];
  variant?: "default" | "primary";
  triggerRef?: Ref<HTMLButtonElement>;
  shouldRestoreFocusOnSelect?: boolean;
}) {
  const hasSelectedAction = useRef(false);

  return (
    <DropdownMenu.Root modal={false} onOpenChange={isOpen => {
      if (isOpen) hasSelectedAction.current = false;
    }}>
      <DropdownMenu.Trigger asChild>
        <Button
          ref={triggerRef}
          variant={variant === "primary" ? "primary" : "secondary"}
          className="gc-dropdown-trigger"
        >
          {label}
          <ChevronDown size={16} aria-hidden />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="gc-floating gc-action-menu"
          align="end"
          sideOffset={6}
          onCloseAutoFocus={event => {
            // The selected command moves focus to its dialog or composer.
            if (!shouldRestoreFocusOnSelect && hasSelectedAction.current) event.preventDefault();
          }}
        >
          {items.map(item => (
            <ActionMenuEntry
              key={item.label}
              item={item}
              onActionSelect={() => { hasSelectedAction.current = true; }}
            />
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function ActionMenuEntry({ item, onActionSelect }: { item: Item; onActionSelect: () => void }) {
  const className = item.isDestructive ? "gc-option gc-danger" : "gc-option";
  const content = item.description === undefined ? item.label : (
    <><span>{item.label}</span>{" "}<span className="gc-action-menu-description">{item.description}</span></>
  );

  return (
    <>
      {item.hasSeparatorBefore && <DropdownMenu.Separator className="gc-action-menu-separator" />}
      {"href" in item ? (
        <DropdownMenu.Item className={className} asChild>
          <a href={item.href} onClick={item.onClick}>{content}</a>
        </DropdownMenu.Item>
      ) : (
        <DropdownMenu.Item className={className} onSelect={() => {
          onActionSelect();
          item.onSelect();
        }}>
          {content}
        </DropdownMenu.Item>
      )}
    </>
  );
}
