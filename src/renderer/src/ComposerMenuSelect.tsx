import { ChevronDown } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

// A composer picker (expert, work mode, runtime agent/preset/action) with a
// roving-focus menu. Moved out of App.tsx unchanged.

export type ComposerMenuOption<T extends string> = {
  value: T;
  label: string;
  description: string;
  disabled?: boolean;
};

export type RuntimeActionChoice = ComposerMenuOption<string> & {
  action?: { type: "command"; id: string } | { type: "prompt"; prompt: string };
};

export function ComposerMenuSelect<T extends string>({
  ariaLabel,
  className,
  describedBy,
  disabled = false,
  icon,
  menuOpen,
  onChange,
  onOpenChange,
  options,
  triggerLabel,
  value,
}: {
  ariaLabel: string;
  className: string;
  describedBy?: string;
  disabled?: boolean;
  icon: ReactNode;
  menuOpen: boolean;
  onChange: (value: T) => void;
  onOpenChange: (open: boolean) => void;
  options: readonly ComposerMenuOption<T>[];
  triggerLabel?: string;
  value: T;
}): React.JSX.Element {
  const { t } = useTranslation("app");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedOption =
    options.find((option) => option.value === value) ?? options[0];
  const selectionLabel = t("composer.menuSelection", {
    label: ariaLabel,
    selection: selectedOption?.label ?? "",
  });

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const menu = menuRef.current;
    if (!menu) {
      return;
    }
    const menuItems = Array.from(
      menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    ).filter((item) => !item.disabled);
    const initialItem =
      menuItems.find((item) => item.getAttribute("aria-checked") === "true") ??
      menuItems[0];
    menuItems.forEach((item) => {
      item.tabIndex = item === initialItem ? 0 : -1;
    });
    const focusFrame = requestAnimationFrame(() => {
      initialItem?.focus();
    });
    const isMenuTarget = (target: EventTarget | null): boolean =>
      target instanceof Node &&
      (menu.contains(target) || buttonRef.current?.contains(target) === true);
    const dismissOnOutsidePointer = (event: PointerEvent): void => {
      if (!isMenuTarget(event.target)) {
        onOpenChange(false);
      }
    };
    const dismissOnOutsideFocus = (event: FocusEvent): void => {
      if (!isMenuTarget(event.target)) {
        onOpenChange(false);
      }
    };
    document.addEventListener("pointerdown", dismissOnOutsidePointer);
    document.addEventListener("focusin", dismissOnOutsideFocus);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", dismissOnOutsidePointer);
      document.removeEventListener("focusin", dismissOnOutsideFocus);
    };
  }, [menuOpen, onOpenChange, value]);

  return (
    <div className={`runtime-picker composer-picker ${className}`}>
      <button
        aria-describedby={describedBy}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        aria-label={selectionLabel}
        className="model-button composer-picker__button"
        disabled={disabled}
        onClick={() => onOpenChange(!menuOpen)}
        onKeyDown={(event) => {
          if (
            !menuOpen &&
            (event.key === "ArrowDown" ||
              event.key === "Enter" ||
              event.key === " ")
          ) {
            event.preventDefault();
            onOpenChange(true);
          }
        }}
        ref={buttonRef}
        title={selectionLabel}
        type="button"
      >
        {icon}
        <span className="model-button__label">
          {triggerLabel ?? selectedOption?.label}
        </span>
        <ChevronDown aria-hidden="true" size={14} />
      </button>
      {menuOpen && (
        <div
          aria-label={ariaLabel}
          className="runtime-picker__menu composer-picker__menu"
          onKeyDown={(event) => {
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="menuitemradio"]',
              ),
            ).filter((item) => !item.disabled);
            const currentIndex = items.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            let nextIndex: number | undefined;
            if (event.key === "ArrowDown") {
              nextIndex = (currentIndex + 1) % items.length;
            } else if (event.key === "ArrowUp") {
              nextIndex = (currentIndex - 1 + items.length) % items.length;
            } else if (event.key === "Home") {
              nextIndex = 0;
            } else if (event.key === "End") {
              nextIndex = items.length - 1;
            } else if (event.key === "Escape") {
              event.preventDefault();
              onOpenChange(false);
              buttonRef.current?.focus();
            }
            const nextItem =
              nextIndex === undefined ? undefined : items.at(nextIndex);
            if (nextItem) {
              event.preventDefault();
              items.forEach((item) => {
                item.tabIndex = item === nextItem ? 0 : -1;
              });
              nextItem.focus();
            }
          }}
          ref={menuRef}
          role="menu"
        >
          {options.map((option) => (
            <button
              aria-checked={option.value === value}
              disabled={option.disabled}
              key={option.value}
              onClick={() => {
                onChange(option.value);
                onOpenChange(false);
                requestAnimationFrame(() => {
                  buttonRef.current?.focus();
                });
              }}
              role="menuitemradio"
              tabIndex={option.value === value ? 0 : -1}
              type="button"
            >
              <span>{option.label}</span>
              <small>{option.description}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
