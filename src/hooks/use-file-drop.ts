import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
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
  enabled: boolean,
  onDrop: (workspace: string, folder: string, paths: string[]) => void,
  onError: (message: string) => void,
) {
  const handlers = useLatestHandlers({ onDrop, onError });
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let highlighted: HTMLElement | null = null;
    function highlight(element: HTMLElement | null) {
      if (element === highlighted) return;
      highlighted?.removeAttribute("data-file-hover");
      highlighted = element;
      highlighted?.setAttribute("data-file-hover", "");
    }
    type Hover = { position: { x: number; y: number } };
    const options = { target: "main" };
    const hover = ({ payload }: { payload: Hover }) => {
      if (!disposed) highlight(fileDropTarget(payload.position));
    };
    const subscriptions = [
      listen<Hover>("tauri://drag-enter", hover, options),
      listen<Hover>("tauri://drag-over", hover, options),
      listen("tauri://drag-leave", () => highlight(null), options),
      listen<Hover & { paths: string[] }>(
        "tauri://drag-drop",
        ({ payload }) => {
          if (disposed) return;
          const element = fileDropTarget(payload.position);
          highlight(null);
          if (element?.dataset.fileWorkspace && payload.paths.length)
            handlers.onDrop(
              element.dataset.fileWorkspace,
              element.dataset.uploadFolder ?? ".",
              payload.paths,
            );
        },
        options,
      ),
    ].map((subscription) =>
      Promise.resolve(subscription).catch((error) => {
        if (!disposed) handlers.onError(String(error));
      }),
    );
    return () => {
      disposed = true;
      highlight(null);
      for (const subscription of subscriptions) void subscription.then((unlisten) => unlisten?.());
    };
  }, [enabled, handlers]);
}
