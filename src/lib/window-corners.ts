import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { api } from "./api";

export const COMPOSITING_CHANGED = "window-compositing-changed";

export interface WindowCornerState {
  composited: boolean;
  maximized: boolean;
  fullscreen: boolean;
}

// Windows 11 rounds undecorated windows itself; page-drawn Linux corners need a compositor.
export function roundedWindowCorners({ composited, maximized, fullscreen }: WindowCornerState) {
  return composited && !maximized && !fullscreen;
}

export function useRoundedWindowCorners() {
  useEffect(() => {
    const root = document.documentElement;
    const state: WindowCornerState = { composited: false, maximized: false, fullscreen: false };
    const unlisten: Promise<() => void>[] = [];
    let disposed = false;
    let generation = 0;
    const apply = () => {
      if (!disposed && roundedWindowCorners(state)) root.dataset.windowCorners = "rounded";
      else delete root.dataset.windowCorners;
    };
    const start = async () => {
      const composited = await api.windowCompositing();
      if (disposed || typeof composited !== "boolean") return;
      const appWindow = getCurrentWindow();
      const readSize = async () => {
        const current = ++generation;
        const [maximized, fullscreen] = await Promise.all([
          appWindow.isMaximized(),
          appWindow.isFullscreen(),
        ]);
        if (current !== generation) return;
        Object.assign(state, { maximized, fullscreen });
        apply();
      };
      unlisten.push(
        appWindow.onResized(() => void readSize().catch(() => {})),
        listen<boolean>(COMPOSITING_CHANGED, ({ payload }) => {
          state.composited = payload;
          apply();
        }),
      );
      state.composited = composited;
      await readSize();
    };
    void start().catch(() => {});
    return () => {
      disposed = true;
      delete root.dataset.windowCorners;
      for (const pending of unlisten) void pending.then((stop) => stop()).catch(() => {});
    };
  }, []);
}
