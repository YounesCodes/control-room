import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** One thing a terminal can be opened against. */
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
  /** Named for screen readers, and shown to no one else. */
  label: string;
  groups: TerminalTargetGroup[];
  /** Rendered above the groups. Split uses it for its direction switch. */
  children?: ReactNode;
  onClose: () => void;
  className?: string;
  /** Set by a caller that positions the menu itself rather than anchoring it. */
  style?: React.CSSProperties;
  /** True while the menu plays its closing transition before unmounting. */
  closing?: boolean;
}

/**
 * The grouped list of terminal targets, shared by "New terminal" and Split.
 *
 * Both menus answer the same question, "which Saved Connection or Local Shell
 * Profile", and differ only in what they do with the answer. Splitting can also
 * adopt a terminal that already exists, which is why the groups are passed in
 * rather than derived here: the component owns presentation and keyboard
 * movement, and each caller owns what its targets mean.
 *
 * One row is always the menu's active target — highlighted, with its identity
 * mark revealed, exactly like a native menu's selection. Hovering moves it and
 * the arrow keys continue from it, so keyboard selection stays visible no
 * matter whether the menu was opened by mouse or keyboard; relying on
 * :focus-visible alone would drop the highlight, since a script-focused row
 * after a pointer open is not "focus visible" to the browser.
 *
 * Empty groups are dropped, so a machine with no local shells installed shows
 * no "Local terminals" heading rather than an empty one.
 */
export function TerminalTargetMenu({
  label,
  groups,
  children,
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
    // The first target, not the first focusable thing: Split puts its direction
    // switch above the list, and opening the menu on it would make the arrow
    // keys start somewhere the reader did not ask about. Runs on mount and
    // again when a quick reopen cancels the closing transition, since the
    // menu element stayed mounted and would otherwise never pull focus back.
    // A layout effect, so the row owns focus before any further input lands.
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
    // Wraps, so a list shorter than the reader expects still moves. Continues
    // from the active row — where hover left it — not from wherever DOM focus
    // happens to sit.
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
    </div>
  );
}
