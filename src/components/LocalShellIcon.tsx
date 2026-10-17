import { SquareTerminal } from "lucide-react";
import type { LocalShellKind } from "../types";

// Git: Simple Icons 16.12.0, CC0. PowerShell: PowerShell/PowerShell assets/ps_black_64.svg.
// Trademarks belong to their owners.
// Monochrome paths keep terminal identities consistent with the host OS marks.
export function LocalShellIcon({ kind }: { kind: LocalShellKind }) {
  return (
    <span className={`local-shell-icon local-shell-icon-${kind}`} aria-hidden="true">
      {kind === "git-bash" ? (
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M23.546 10.93L13.067.452c-.604-.603-1.582-.603-2.188 0L8.708 2.627l2.76 2.76c.645-.215 1.379-.07 1.889.441.516.515.658 1.258.438 1.9l2.658 2.66c.645-.223 1.387-.078 1.9.435.721.72.721 1.884 0 2.604-.719.719-1.881.719-2.6 0-.539-.541-.674-1.337-.404-1.996L12.86 8.955v6.525c.176.086.342.203.488.348.713.721.713 1.883 0 2.6-.719.721-1.889.721-2.609 0-.719-.719-.719-1.879 0-2.598.182-.18.387-.316.605-.406V8.835c-.217-.091-.424-.222-.6-.401-.545-.545-.676-1.342-.396-2.009L7.636 3.7.45 10.881c-.6.605-.6 1.584 0 2.189l10.48 10.477c.604.604 1.582.604 2.186 0l10.43-10.43c.605-.603.605-1.582 0-2.187" />
        </svg>
      ) : kind === "powershell-7" || kind === "windows-powershell" ? (
        <svg viewBox="-2 -2 64 49" fill="currentColor">
          <path
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            d="M2.515 45c-.817 0-1.523-.319-1.989-.899-.476-.592-.64-1.407-.448-2.235L9.071 2.911C9.448 1.279 11.03 0 12.673 0h44.812c.817 0 1.524.319 1.989.899.476.592.64 1.407.448 2.235l-8.993 38.955C50.552 43.721 48.97 45 47.327 45Z"
          />
          <path d="M36.591 23.227c-.186.375-.572.788-1.255 1.268L15.28 38.899c-1.095.796-2.667.501-3.511-.659-.843-1.16-.64-2.745.455-3.541L30.31 21.602v-.269L18.946 9.244c-.927-.986-.83-2.58.216-3.562 1.046-.981 2.645-.977 3.572.009L36.37 20.197c.774.824.831 2.07.221 3.03ZM29.774 34H40.58c1.257 0 2.275 1.008 2.275 2.25s-1.018 2.25-2.275 2.25H29.774c-1.257 0-2.275-1.008-2.275-2.25S28.517 34 29.774 34Z" />
        </svg>
      ) : (
        <SquareTerminal size={17} strokeWidth={1.8} />
      )}
    </span>
  );
}
