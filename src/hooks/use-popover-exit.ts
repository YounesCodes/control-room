import { useEffect, useState } from "react";

export const POPOVER_EXIT_MS = 110;

export function usePopoverExit(open: boolean): { present: boolean; closing: boolean } {
  const [unmounted, setUnmounted] = useState(!open);
  const present = open || !unmounted;

  useEffect(() => {
    if (open) {
      setUnmounted(false);
      return;
    }
    if (unmounted) return;
    const timer = setTimeout(() => setUnmounted(true), POPOVER_EXIT_MS);
    return () => clearTimeout(timer);
  }, [open, unmounted]);

  return { present, closing: !open && present };
}
