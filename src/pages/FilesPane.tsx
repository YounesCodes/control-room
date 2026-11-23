import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, errorMessage } from "../lib/api";
import {
  ArrowDownToLine,
  ArrowUp,
  ArrowUpFromLine,
  Check,
  ChevronRight,
  File,
  Folder,
  House,
  Pencil,
  RefreshCw,
  X,
} from "lucide-react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Bone, Skeleton, SkeletonRows } from "../components/PanelState";
import { Search } from "../components/MagnifierIcon";
import { RemoteFolderPath } from "../components/RemoteFolderPath";
import { FolderBreadcrumbs } from "../components/FolderBreadcrumbs";
import {
  belongsTo,
  cancelJob,
  clearFinished,
  enqueue,
  fileJobs,
  replaceJob,
  subscribeFileJobs,
  uploadFiles,
  type FileJob,
  type RemoteFolder,
} from "../lib/file-transfers";
import { formatByteRate } from "../lib/header-metrics";
import { showOverflowTitle } from "../lib/overflow-title";
import type { SavedConnection } from "../types";

function size(value: number) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const unit = Math.min(units.length - 1, Math.floor(Math.log2(Math.max(value, 1)) / 10));
  return `${Number((value / 1024 ** unit).toFixed(1))} ${units[unit]}`;
}
const join = (dir: string, name: string) => dir.replace(/\/$/, "") + "/" + name;

function matchedName(name: string, match: RegExp | null) {
  if (!match) return name;
  return name
    .split(match)
    .map((part, index) => (index % 2 === 1 ? <mark key={index}>{part}</mark> : part));
}

function Activity({ jobs, connection }: { jobs: FileJob[]; connection: SavedConnection }) {
  const [prompt, setPrompt] = useState<string | null>(null);
  const pending = jobs.find((job) => job.status === "exists" && job.id === prompt);
  return (
    <section className="file-activity" aria-label="Transfers">
      <header>
        <h3>Transfers</h3>
        {jobs.some((job) => ["complete", "failed", "canceled"].includes(job.status)) && (
          <button className="secondary-button" onClick={() => clearFinished(connection)}>
            Clear finished
          </button>
        )}
      </header>
      <ul>
        {jobs.map((job) => {
          const active = job.status === "active";
          const progress = job.progress;
          const label = {
            queued: "Queued",
            active: job.direction === "upload" ? "Uploading" : "Downloading",
            canceling: "Canceling…",
            canceled: "Canceled",
            exists: "File already exists",
            failed: "Failed",
            complete: job.direction === "upload" ? "Uploaded" : "Downloaded",
          }[job.status];
          const Icon =
            job.status === "complete"
              ? Check
              : job.direction === "upload"
                ? ArrowUpFromLine
                : ArrowDownToLine;
          return (
            <li key={job.id}>
              <Icon size={16} aria-hidden="true" />
              <div className="file-job">
                <strong onMouseEnter={showOverflowTitle}>{job.name}</strong>
                <span>
                  <span role="status">{label}</span>
                  {active &&
                    progress &&
                    ` · ${size(progress.bytes)}${progress.total === null ? "" : ` of ${size(progress.total)}`} · ${formatByteRate(progress.bytesPerSecond)}`}
                </span>
                {active && progress && (
                  <progress
                    aria-label={`Transfer progress for ${job.name}`}
                    value={progress.total === null ? undefined : progress.bytes}
                    max={Math.max(progress.total ?? 1, 1)}
                  />
                )}
                {job.error && job.status !== "canceled" && (
                  <div className="inline-error" role="alert">
                    {job.error}
                  </div>
                )}
              </div>
              {job.status === "exists" && (
                <button className="secondary-button" onClick={() => setPrompt(job.id)}>
                  Review
                </button>
              )}
              {["active", "queued", "exists"].includes(job.status) && (
                <button
                  className="icon-button"
                  aria-label={`Cancel transfer of ${job.name}`}
                  title="Cancel transfer"
                  onClick={() => cancelJob(job.id)}
                >
                  <X size={15} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {pending && (
        <ConfirmDialog
          title="Replace existing file?"
          message={
            <>
              <strong>{pending.name}</strong> already exists in{" "}
              {pending.direction === "upload"
                ? pending.remotePath === "."
                  ? "the remote home folder"
                  : pending.remotePath
                : pending.localPath}
              . Replacing it will overwrite its contents.
            </>
          }
          confirmLabel="Replace file"
          cancelLabel="Keep existing file"
          danger
          onClose={() => {
            cancelJob(pending.id);
            setPrompt(null);
          }}
          onConfirm={() => {
            replaceJob(pending.id);
            setPrompt(null);
          }}
        />
      )}
    </section>
  );
}

export function FilesPane({
  connection,
  workspaceId,
}: {
  connection: SavedConnection;
  workspaceId: string;
}) {
  const jobs = useSyncExternalStore(subscribeFileJobs, fileJobs).filter((job) =>
    belongsTo(job, connection),
  );
  const completedUploads = jobs.filter(
    (job) => job.direction === "upload" && job.status === "complete",
  ).length;
  const [request, setRequest] = useState<{ path: string | null }>({ path: null });
  const [folder, setFolder] = useState<RemoteFolder | null>(null);
  const [pathDraft, setPathDraft] = useState<string | null>(null);
  const [editingPath, setEditingPath] = useState(false);
  const editPathButton = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<{ message: string; retry: boolean } | null>(null);
  const [filter, setFilter] = useState("");
  const [visibleCount, setVisibleCount] = useState(100);
  const [hidden, setHidden] = useState(false);
  const displayedPath = useRef<string | null>(null);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let current = true;
    setBusy(true);
    setError(null);
    void api
      .listTransferFolder(connection.id, request.path)
      .then(
        (result) => {
          if (current) {
            setFolder(result);
            if (displayedPath.current !== result.path) {
              displayedPath.current = result.path;
              setFilter("");
              setVisibleCount(100);
            }
          }
        },
        (reason: unknown) => {
          if (!current) return;
          if (
            reason !== null &&
            typeof reason === "object" &&
            "message" in reason &&
            typeof reason.message === "string" &&
            "permissionDenied" in reason &&
            typeof reason.permissionDenied === "boolean"
          ) {
            setError({ message: reason.message, retry: !reason.permissionDenied });
          } else {
            setError({ message: errorMessage(reason), retry: true });
          }
        },
      )
      .finally(() => {
        if (current) setBusy(false);
      });
    return () => {
      current = false;
    };
  }, [connection.id, request, completedUploads]);

  function openFolder(path: string | null) {
    setBusy(true);
    setEditingPath(false);
    setPathDraft(null);
    setRequest({ path });
  }

  async function pick(entry?: RemoteFolder["entries"][number]) {
    if (!folder) return;
    try {
      const picked = await api.chooseTransferPaths(entry ? "download" : "upload");
      if (!picked.length || !alive.current) return;
      if (entry)
        enqueue(connection, "download", [
          {
            name: entry.name,
            localPath: picked[0],
            remotePath: join(folder.path, entry.name),
            folder: entry.kind === "folder",
          },
        ]);
      else uploadFiles(connection, folder.path, picked);
    } catch (reason) {
      if (alive.current) setError({ message: errorMessage(reason), retry: false });
    }
  }
  const match = useMemo(
    () => (filter ? new RegExp(`(${filter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "giu") : null),
    [filter],
  );
  const entries = useMemo(
    () =>
      folder?.entries.filter(
        (entry) =>
          (hidden || !entry.name.startsWith(".")) && (!match || entry.name.search(match) !== -1),
      ) ?? [],
    [folder, hidden, match],
  );
  const parent = folder?.path.replace(/\/[^/]+\/?$/, "") || "/";
  const folderPath = pathDraft ?? folder?.path ?? "";
  const canUpload = folder !== null && !busy && folderPath === folder.path;
  return (
    <section
      className="feature-page files-page"
      data-file-workspace={canUpload ? workspaceId : undefined}
      data-upload-folder={folder?.path}
    >
      <header className="page-heading compact-heading">
        <h2>Files</h2>
        <button className="secondary-button" onClick={() => void pick()} disabled={!canUpload}>
          <ArrowUpFromLine size={15} /> Upload files
        </button>
      </header>
      {jobs.length > 0 && <Activity jobs={jobs} connection={connection} />}
      {error && (
        <div className="inline-error" role="alert">
          <span>{error.message}</span>
          {error.retry && (
            <button className="inline-action" onClick={() => openFolder(request.path)}>
              Try again
            </button>
          )}
        </div>
      )}
      {!folder && busy && request.path === null && (
        <Skeleton label="Reading remote folder">
          <Bone shape="control" width="100%" />
          <SkeletonRows count={6} />
        </Skeleton>
      )}
      {(folder || !busy || request.path !== null) && (
        <div className="file-browser" aria-busy={busy}>
          <div className="file-location">
            <button
              className="icon-button"
              title="Home folder"
              aria-label="Home folder"
              disabled={busy}
              onClick={() => openFolder(null)}
            >
              <House size={16} />
            </button>
            <button
              className="icon-button"
              title="Parent folder"
              aria-label="Parent folder"
              disabled={busy || !folder || folder.path === "/"}
              onClick={() => openFolder(parent)}
            >
              <ArrowUp size={16} />
            </button>
            {editingPath ? (
              <RemoteFolderPath
                connectionId={connection.id}
                folder={folder}
                draft={pathDraft}
                busy={busy}
                showHidden={hidden}
                onEdit={setPathDraft}
                onOpen={(path) => {
                  openFolder(path);
                  editPathButton.current?.focus();
                }}
                onClose={() => {
                  setEditingPath(false);
                  setPathDraft(null);
                  editPathButton.current?.focus();
                }}
              />
            ) : (
              <FolderBreadcrumbs path={folder?.path ?? null} busy={busy} onOpen={openFolder} />
            )}
            <button
              ref={editPathButton}
              className="icon-button"
              title={editingPath ? "Close path editor" : "Edit path"}
              aria-label={editingPath ? "Close path editor" : "Edit path"}
              aria-expanded={editingPath}
              onClick={() => {
                setPathDraft(null);
                setEditingPath(!editingPath);
              }}
            >
              {editingPath ? <X size={15} /> : <Pencil size={15} />}
            </button>
            <button
              className="icon-button"
              title="Refresh folder"
              aria-label="Refresh folder"
              disabled={busy || !folder}
              onClick={() => openFolder(folder?.path ?? null)}
            >
              <RefreshCw size={15} />
            </button>
          </div>
          {folder && (
            <div className="file-filter">
              <label className="search-field">
                <Search size={15} />
                <input
                  type="search"
                  aria-label="Filter this folder"
                  placeholder="Filter this folder"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={hidden}
                  onChange={(e) => setHidden(e.target.checked)}
                />
                Show hidden files
              </label>
            </div>
          )}
          {folder && (
            <ul className="file-list" aria-label="Remote files">
              {entries.slice(0, visibleCount).map((entry) => {
                const isFolder = entry.kind === "folder";
                const Icon = isFolder ? Folder : File;
                return (
                  <li className="file-entry" key={entry.name}>
                    <button
                      className="file-row"
                      disabled={busy || entry.kind === "other"}
                      aria-label={`${isFolder ? "Open folder" : "Download"} ${entry.name}`}
                      onClick={() =>
                        isFolder ? openFolder(join(folder.path, entry.name)) : void pick(entry)
                      }
                    >
                      <Icon size={17} />
                      <span onMouseEnter={showOverflowTitle}>{matchedName(entry.name, match)}</span>
                      <small>
                        {entry.kind === "file" && entry.size !== null
                          ? size(entry.size)
                          : entry.kind === "other"
                            ? "Special file"
                            : ""}
                      </small>
                      {isFolder ? (
                        <ChevronRight size={15} />
                      ) : entry.kind === "file" ? (
                        <ArrowDownToLine size={15} />
                      ) : null}
                    </button>
                    {isFolder && (
                      <button
                        className="icon-button file-folder-download"
                        disabled={busy}
                        aria-label={`Download folder ${entry.name}`}
                        title="Download folder"
                        onClick={() => void pick(entry)}
                      >
                        <ArrowDownToLine size={15} />
                      </button>
                    )}
                  </li>
                );
              })}
              {entries.length > visibleCount && (
                <li>
                  <button
                    className="secondary-button"
                    onClick={() => setVisibleCount((count) => count + 100)}
                  >
                    Show more files
                  </button>
                </li>
              )}
            </ul>
          )}
          {folder && !entries.length && (
            <p className="files-empty">
              {filter
                ? "No matching files"
                : folder.entries.length
                  ? "No visible files"
                  : "This folder is empty"}
            </p>
          )}
          {folder && (
            <footer className="file-drop-hint">
              <ArrowUpFromLine size={14} /> Drop local files here to upload
            </footer>
          )}
        </div>
      )}
    </section>
  );
}
