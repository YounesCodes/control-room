import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";
import type { EnvironmentInfo } from "../types";

type WindowActions = Pick<
  ReturnType<typeof getCurrentWindow>,
  "close" | "minimize" | "toggleMaximize"
>;

interface WindowControlsProps {
  platform: EnvironmentInfo["platform"];
  windowActions?: WindowActions;
}

export function WindowControls({ platform, windowActions }: WindowControlsProps) {
  // macOS uses the native decorated titlebar and its traffic lights. Windows
  // keeps the existing custom controls because its window remains undecorated.
  if (platform !== "windows") return null;
  const appWindow = windowActions ?? getCurrentWindow();

  return (
    <>
      <span className="window-controls-divider" aria-hidden="true" />
      <div className="window-controls" aria-label="Window controls">
        <button
          className="window-control-button"
          type="button"
          onClick={() => void appWindow.minimize()}
          aria-label="Minimize window"
          title="Minimize"
        >
          <Minus size={16} strokeWidth={1.6} />
        </button>
        <button
          className="window-control-button"
          type="button"
          onClick={() => void appWindow.toggleMaximize()}
          aria-label="Maximize or restore window"
          title="Maximize or restore"
        >
          <Square size={12} strokeWidth={1.4} />
        </button>
        <button
          className="window-control-button window-close-button"
          type="button"
          onClick={() => void appWindow.close()}
          aria-label="Close window"
          title="Close"
        >
          <X size={17} strokeWidth={1.5} />
        </button>
      </div>
    </>
  );
}
