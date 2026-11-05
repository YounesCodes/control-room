import { Shield, SquareTerminal } from "lucide-react";
import type { LocalShellKind } from "../types";
import gitBashIcon from "../assets/shells/git-for-windows.ico";

// Git Bash: git-for-windows/build-extra, portable/root/usr/share/git/git-for-windows.ico.
// PowerShell: PowerShell/PowerShell assets/ps_black_64.svg.
// Trademarks belong to their owners.
// Vector marks inherit identity colors; Git Bash retains the upstream artwork.
export function LocalShellIcon({
  kind,
  elevated = false,
}: {
  kind: LocalShellKind;
  elevated?: boolean;
}) {
  return (
    <span
      className={`local-shell-icon local-shell-mark identity-mark local-shell-icon-${kind}`}
      aria-hidden="true"
    >
      {kind === "git-bash" ? (
        <img src={gitBashIcon} alt="" draggable={false} />
      ) : kind === "powershell-7" || kind === "windows-powershell" ? (
        <svg
          viewBox="0 0 60 45"
          fill="currentColor"
          fillRule="evenodd"
          shapeRendering="geometricPrecision"
        >
          <path d="M2.515 45c-.817 0-1.523-.319-1.989-.899-.476-.592-.64-1.407-.448-2.235L9.071 2.911C9.448 1.279 11.03 0 12.673 0h44.812c.817 0 1.524.319 1.989.899.476.592.64 1.407.448 2.235l-8.993 38.955C50.552 43.721 48.97 45 47.327 45ZM36.591 23.227c-.186.375-.572.788-1.255 1.268L15.28 38.899c-1.095.796-2.667.501-3.511-.659-.843-1.16-.64-2.745.455-3.541L30.31 21.602v-.269L18.946 9.244c-.927-.986-.83-2.58.216-3.562 1.046-.981 2.645-.977 3.572.009L36.37 20.197c.774.824.831 2.07.221 3.03ZM29.774 34H40.58c1.257 0 2.275 1.008 2.275 2.25s-1.018 2.25-2.275 2.25H29.774c-1.257 0-2.275-1.008-2.275-2.25S28.517 34 29.774 34Z" />
        </svg>
      ) : (
        <SquareTerminal size={17} strokeWidth={1.8} />
      )}
      {elevated && <Shield className="local-shell-elevation" strokeWidth={2} />}
    </span>
  );
}
