import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

interface ModalProps {
  title: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
}

export function Modal({ title, children, onClose, className }: ModalProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const focusable = () =>
      [
        ...(dialog?.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]") ??
          []),
      ].filter((element) => {
        if (
          element.matches(":disabled") ||
          element.tabIndex < 0 ||
          element.closest("[hidden], [inert]")
        )
          return false;
        if (element instanceof HTMLInputElement && element.type === "hidden") return false;
        for (
          let ancestor: HTMLElement | null = element;
          ancestor && ancestor !== dialog;
          ancestor = ancestor.parentElement
        ) {
          const style = getComputedStyle(ancestor);
          if (style.display === "none" || style.visibility === "hidden") return false;
        }
        if (element instanceof HTMLInputElement && element.type === "radio" && element.name) {
          const group = [
            ...(dialog?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ?? []),
          ].filter((radio) => radio.name === element.name && !radio.matches(":disabled"));
          return element === (group.find((radio) => radio.checked) ?? group[0]);
        }
        return true;
      });
    if (!dialog?.querySelector("[autofocus]")) {
      const preferred = focusable().find((element) => !element.hasAttribute("data-modal-close"));
      (preferred ?? dialog)?.focus();
    }

    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      // WebKit can skip buttons depending on macOS keyboard-navigation
      // preferences. Own the whole cycle so every dialog action stays reachable.
      event.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLElement);
      const next =
        current < 0
          ? event.shiftKey
            ? items.length - 1
            : 0
          : (current + (event.shiftKey ? -1 : 1) + items.length) % items.length;
      items[next].focus();
    }

    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      previousFocus?.focus();
    };
  }, []);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className={["modal", className].filter(Boolean).join(" ")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-app-popover=""
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close"
            data-modal-close
          >
            <X size={17} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
