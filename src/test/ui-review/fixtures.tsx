import { createRoot } from "react-dom/client";
import { App } from "../../App";
import { TooltipLayer } from "../../components/TooltipLayer";
import "@xterm/xterm/css/xterm.css";
import "@fontsource-variable/inter/opsz.css";
import "../../styles.css";

createRoot(document.getElementById("root")!).render(
  <>
    <App />
    <TooltipLayer />
  </>,
);
