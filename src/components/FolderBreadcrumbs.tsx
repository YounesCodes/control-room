import { useLayoutEffect, useRef } from "react";
import { ChevronRight } from "lucide-react";
import { showOverflowTitle } from "../lib/overflow-title";

export function FolderBreadcrumbs({
  path,
  busy,
  onOpen,
}: {
  path: string | null;
  busy: boolean;
  onOpen: (path: string) => void;
}) {
  const nav = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (nav.current) nav.current.scrollLeft = nav.current.scrollWidth;
  }, [path]);

  if (path === null) return <div className="file-breadcrumbs" />;
  const segments = path.split("/").filter(Boolean);
  const crumbs = [{ name: "/", path: "/" }];
  let ancestor = "";
  for (const name of segments) {
    ancestor += `/${name}`;
    crumbs.push({ name, path: /^\/[a-z]:$/i.test(ancestor) ? `${ancestor}/` : ancestor });
  }

  return (
    <nav className="file-breadcrumbs" aria-label="Remote folder" ref={nav}>
      <ol>
        {crumbs.map((crumb, index) => (
          <li key={crumb.path}>
            {index !== 0 && <ChevronRight size={12} aria-hidden="true" />}
            {index === crumbs.length - 1 ? (
              <span className="file-crumb" aria-current="location" onMouseEnter={showOverflowTitle}>
                {crumb.name}
              </span>
            ) : (
              <button
                className="file-crumb"
                type="button"
                aria-label={index === 0 ? "Open root folder" : `Open ${crumb.path}`}
                disabled={busy}
                onClick={() => onOpen(crumb.path)}
                onMouseEnter={showOverflowTitle}
              >
                {crumb.name}
              </button>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
