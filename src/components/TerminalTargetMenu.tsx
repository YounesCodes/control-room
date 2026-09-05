import { useEffect, useRef, type ReactNode } from "react";

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
 * Empty groups are dropped, so a machine with no local shells installed shows
 * no "Local terminals" heading rather than an empty one.
 */
export function TerminalTargetMenu({
  label,
  groups,
  children,
  onClose,
  className,
}: TerminalTargetMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const populated = groups.filter((group) => group.options.length > 0);

  useEffect(() => {
    // The first target, not the first focusable thing: Split puts its direction
    // switch above the list, and opening the menu on it would make the arrow
    // keys start somewhere the reader did not ask about.
    menuRef.current?.querySelector<HTMLButtonElement>("[data-terminal-target]")?.focus();
  }, []);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onCloseRef.current();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;

    const targets = [
      ...(menuRef.current?.querySelectorAll<HTMLButtonElement>("[data-terminal-target]") ?? []),
    ];
    if (!targets.length) return;
    event.preventDefault();
    const current = targets.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    // Wraps, so a list shorter than the reader expects still moves.
    const next = (current + step + targets.length) % targets.length;
    targets[current === -1 ? 0 : next].focus();
  }

  return (
    <div
      ref={menuRef}
      className={className ? `terminal-target-menu ${className}` : "terminal-target-menu"}
      role="dialog"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {children}
      {populated.map((group) => (
        <div className="terminal-target-group" key={group.label}>
          <strong>{group.label}</strong>
          {group.options.map((option) => (
            <button
              type="button"
              key={option.id}
              data-terminal-target
              onClick={option.onSelect}
              aria-label={`${group.label}: ${option.label}`}
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
