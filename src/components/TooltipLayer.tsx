import { useEffect, useLayoutEffect, useRef, useState } from "react";

interface TooltipState {
  text: string;
  top: number;
  left: number;
  anchorTop: number;
  alignStart: boolean;
}

const TOOLTIP_DELAY_MS = 350;

function titledElement(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element
    ? target.closest<HTMLElement>("[title], [data-tooltip-title]")
    : null;
}

export function TooltipLayer() {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const activeRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{
    tooltip: TooltipState;
    left: number;
    top: number;
  } | null>(null);

  useLayoutEffect(() => {
    if (!tooltip || !tooltipRef.current) return;
    const width = tooltipRef.current.offsetWidth;
    const height = tooltipRef.current.offsetHeight;
    const left = Math.max(
      8,
      Math.min(tooltip.left - (tooltip.alignStart ? 0 : width / 2), window.innerWidth - width - 8),
    );
    const below = tooltip.top + height <= window.innerHeight - 8;
    const top = Math.max(
      8,
      Math.min(
        below ? tooltip.top : tooltip.anchorTop - height - 8,
        window.innerHeight - height - 8,
      ),
    );
    setPosition({ tooltip, left, top });
  }, [tooltip]);

  useEffect(() => {
    function restoreTitle() {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      const active = activeRef.current;
      if (active?.dataset.tooltipTitle) {
        if (!active.hasAttribute("title")) active.title = active.dataset.tooltipTitle;
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
        timerRef.current = null;
        if (!target.isConnected) {
          restoreTitle();
          return;
        }
        const rect = target.getBoundingClientRect();
        setTooltip({
          text,
          top: rect.bottom + 8,
          left: target.dataset.tooltipAlign === "start" ? rect.left : rect.left + rect.width / 2,
          alignStart: target.dataset.tooltipAlign === "start",
          anchorTop: rect.top,
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

    function keyDown(event: KeyboardEvent) {
      if (event.key === "Escape") restoreTitle();
    }

    const observer = new MutationObserver(() => {
      const active = activeRef.current;
      if (active && (!active.isConnected || active.hasAttribute("title"))) restoreTitle();
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["title"],
    });

    document.addEventListener("pointerover", pointerOver);
    document.addEventListener("pointerout", pointerOut);
    document.addEventListener("focusin", focusIn);
    document.addEventListener("focusout", focusOut);
    document.addEventListener("keydown", keyDown);
    window.addEventListener("blur", restoreTitle);
    window.addEventListener("scroll", restoreTitle, true);
    window.addEventListener("resize", restoreTitle);
    return () => {
      document.removeEventListener("pointerover", pointerOver);
      document.removeEventListener("pointerout", pointerOut);
      document.removeEventListener("focusin", focusIn);
      document.removeEventListener("focusout", focusOut);
      document.removeEventListener("keydown", keyDown);
      observer.disconnect();
      window.removeEventListener("blur", restoreTitle);
      window.removeEventListener("scroll", restoreTitle, true);
      window.removeEventListener("resize", restoreTitle);
      restoreTitle();
    };
  }, []);

  return tooltip ? (
    <div
      ref={tooltipRef}
      className="app-tooltip"
      role="tooltip"
      style={
        position?.tooltip === tooltip
          ? { top: position.top, left: position.left }
          : { top: 0, left: 0, visibility: "hidden" }
      }
    >
      {tooltip.text}
    </div>
  ) : null;
}
