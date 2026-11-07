import { AlertCircle } from "lucide-react";

// Every warning line opens with the same sign the baseline capture note uses,
// so a warning is identified by its shape everywhere and not just its hue.
export function WarningSign() {
  return <AlertCircle size={12} aria-hidden="true" />;
}
