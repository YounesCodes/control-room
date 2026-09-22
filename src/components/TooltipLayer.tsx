import { useEffect, useRef, useState } from "react";

interface TooltipState {
  text: string;
  top: number;
  left: number;
}

const TOOLTIP_DELAY_MS = 350;

function titledElement(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>("[title]") : null;
}

export function TooltipLayer() {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const activeRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    function restoreTitle() {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      const active = activeRef.current;
      if (active?.dataset.tooltipTitle) {
        active.title = active.dataset.tooltipTitle;
        delete active.dataset.tooltipTitle;
      }
      if (active?.dataset.tooltipAddedLabel) {
        active.removeAttribute("aria-label");
        delete active.dataset.tooltipAddedLabel;
      }
      activeRef.current = null;
      setTooltip(null);
    }

    function show(target: HTMLElement, delayed: boolean) {
      if (activeRef.current === target) return;
      restoreTitle();
      const text = target.title.trim();
      if (!text) return;
      if (
        !target.hasAttribute("aria-label") &&
        !target.hasAttribute("aria-labelledby") &&
        !target.textContent?.trim()
      ) {
        target.setAttribute("aria-label", text);
        target.dataset.tooltipAddedLabel = "true";
      }
      target.dataset.tooltipTitle = text;
      target.removeAttribute("title");
      activeRef.current = target;
      const reveal = () => {
        const rect = target.getBoundingClientRect();
        setTooltip({
          text,
          top: Math.min(window.innerHeight - 8, rect.bottom + 8),
          left: Math.max(8, Math.min(rect.left + rect.width / 2, window.innerWidth - 8)),
        });
      };
      if (delayed) timerRef.current = window.setTimeout(reveal, TOOLTIP_DELAY_MS);
      else reveal();
    }

    function pointerOver(event: PointerEvent) {
      const target = titledElement(event.target);
      if (target) show(target, true);
    }

    function pointerOut(event: PointerEvent) {
      const active = activeRef.current;
      if (!active) return;
      if (event.relatedTarget instanceof Node && active.contains(event.relatedTarget)) return;
      restoreTitle();
    }

    function focusIn(event: FocusEvent) {
      const target = titledElement(event.target);
      if (target) show(target, false);
    }

    function focusOut(event: FocusEvent) {
      const active = activeRef.current;
      if (!active) return;
      if (event.relatedTarget instanceof Node && active.contains(event.relatedTarget)) return;
      restoreTitle();
    }

    document.addEventListener("pointerover", pointerOver);
    document.addEventListener("pointerout", pointerOut);
    document.addEventListener("focusin", focusIn);
    document.addEventListener("focusout", focusOut);
    window.addEventListener("blur", restoreTitle);
    window.addEventListener("scroll", restoreTitle, true);
    window.addEventListener("resize", restoreTitle);
    return () => {
      document.removeEventListener("pointerover", pointerOver);
      document.removeEventListener("pointerout", pointerOut);
      document.removeEventListener("focusin", focusIn);
      document.removeEventListener("focusout", focusOut);
      window.removeEventListener("blur", restoreTitle);
      window.removeEventListener("scroll", restoreTitle, true);
      window.removeEventListener("resize", restoreTitle);
      restoreTitle();
    };
  }, []);

  return tooltip ? (
    <div className="app-tooltip" role="tooltip" style={{ top: tooltip.top, left: tooltip.left }}>
      {tooltip.text}
    </div>
  ) : null;
}
