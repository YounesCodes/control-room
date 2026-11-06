import { createRoot } from "react-dom/client";
import { App } from "../../App";
import { TooltipLayer } from "../../components/TooltipLayer";
import "@xterm/xterm/css/xterm.css";
import "@fontsource-variable/inter/opsz.css";
import "../../styles.css";

// Only the native boundary is substituted. App owns all shell/pane geometry.
createRoot(document.getElementById("root")!).render(
  <>
    <App />
    <TooltipLayer />
  </>,
);
