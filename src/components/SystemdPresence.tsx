import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Retain exiting content for its slide, but remove it from focus and accessibility immediately. */
export function SystemdPresence({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const content = useRef(children);
  useLayoutEffect(() => {
    if (open) content.current = children;
  }, [open, children]);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setMounted(false);
      return;
    }
    const timer = setTimeout(() => setMounted(false), 180);
    return () => clearTimeout(timer);
  }, [open]);
  if (!open && !mounted) return null;
  return (
    <div
      className="systemd-presence"
      data-leaving={!open || undefined}
      inert={!open}
      aria-hidden={!open || undefined}
    >
      {open ? children : content.current}
    </div>
  );
}
