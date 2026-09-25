import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { TooltipLayer } from "./components/TooltipLayer";

async function start() {
  if (import.meta.env.MODE === "e2e") await import("@wdio/tauri-plugin");
  createRoot(document.getElementById("root")!).render(
    <>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
      <TooltipLayer />
    </>,
  );
}

void start();
