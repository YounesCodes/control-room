import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface TerminalTargetOption {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
}

export interface TerminalTargetGroup {
  label: string;
  options: TerminalTargetOption[];
}

interface TerminalTargetMenuProps {
  label: string;
  groups: TerminalTargetGroup[];
  children?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  className?: string;
  style?: React.CSSProperties;
  closing?: boolean;
}

export function TerminalTargetMenu({
  label,
  groups,
  children,
  footer,
  onClose,
  className,
  style,
  closing,
}: TerminalTargetMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const populated = groups.filter((group) => group.options.length > 0);
  let rowCounter = -1;
  const sections = populated.map((group) => ({
    label: group.label,
    options: group.options.map((option) => ({ option, index: ++rowCounter })),
  }));
  const [activeIndex, setActiveIndex] = useState(0);
  const [keyboardNav, setKeyboardNav] = useState(false);

  useLayoutEffect(() => {
    if (closing) return;
    setActiveIndex(0);
    setKeyboardNav(false);
    menuRef.current?.querySelector<HTMLButtonElement>("[data-terminal-target]")?.focus();
  }, [closing]);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onCloseRef.current();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;

    const targets = [
      ...(menuRef.current?.querySelectorAll<HTMLButtonElement>("[data-terminal-target]") ?? []),
    ];
    if (!targets.length) return;
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? targets.length - 1
          : (activeIndex + step + targets.length) % targets.length;
    targets[next].focus();
    setActiveIndex(next);
    setKeyboardNav(true);
  }

  return (
    <div
      ref={menuRef}
      className={className ? `terminal-target-menu ${className}` : "terminal-target-menu"}
      style={style}
      role="dialog"
      aria-label={closing ? undefined : label}
      aria-hidden={closing || undefined}
      inert={closing || undefined}
      data-closing={closing || undefined}
      data-app-popover=""
      data-keyboard-nav={keyboardNav || undefined}
      onKeyDown={onKeyDown}
    >
      {children}
      {sections.map((section) => (
        <div className="terminal-target-group" key={section.label}>
          <strong>{section.label}</strong>
          {section.options.map(({ option, index }) => (
            <button
              type="button"
              key={option.id}
              data-terminal-target
              data-active={index === activeIndex ? "true" : undefined}
              onFocus={() => setActiveIndex(index)}
              onMouseEnter={(event) => {
                setActiveIndex(index);
                setKeyboardNav(false);
                event.currentTarget.focus({ preventScroll: true });
              }}
              onClick={option.onSelect}
              aria-label={`${section.label}: ${option.label}`}
            >
              {option.icon}
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      ))}
      {footer}
    </div>
  );
}
