import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useLatestHandlers } from "./use-latest-handlers";

export function fileDropTarget(position: { x: number; y: number }) {
  const target = document.elementFromPoint(
    position.x / window.devicePixelRatio,
    position.y / window.devicePixelRatio,
  );
  if (target?.closest(".modal-backdrop, [role=dialog]")) return null;
  return target?.closest<HTMLElement>("[data-file-workspace]") ?? null;
}

export function useFileDrop(
  onDrop: (workspace: string, folder: string, paths: string[]) => void,
  onError: (message: string) => void,
) {
  const handlers = useLatestHandlers({ onDrop, onError });
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let highlighted: HTMLElement | null = null;
    function highlight(element: HTMLElement | null) {
      if (element === highlighted) return;
      highlighted?.removeAttribute("data-file-hover");
      highlighted = element;
      highlighted?.setAttribute("data-file-hover", "");
    }
    const ready = getCurrentWebview()
      .onDragDropEvent(({ payload }) => {
        if (disposed) return;
        if (payload.type === "leave") {
          highlight(null);
          return;
        }
        const element = fileDropTarget(payload.position);
        if (payload.type !== "drop") {
          highlight(element);
          return;
        }
        highlight(null);
        if (element?.dataset.fileWorkspace && payload.paths.length)
          handlers.onDrop(
            element.dataset.fileWorkspace,
            element.dataset.uploadFolder ?? ".",
            payload.paths,
          );
      })
      .catch((error) => {
        if (!disposed) handlers.onError(String(error));
      });
    return () => {
      disposed = true;
      highlight(null);
      void ready.then((unlisten) => unlisten?.());
    };
  }, [handlers]);
}
