import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import {
  ArrowDownToLine,
  ArrowUp,
  ArrowUpFromLine,
  Check,
  ChevronRight,
  File,
  Folder,
  House,
  RefreshCw,
  X,
} from "lucide-react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Bone, Skeleton, SkeletonRows } from "../components/PanelState";
import { Search } from "../components/MagnifierIcon";
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
import type { SavedConnection } from "../types";

function size(value: number) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const unit = Math.min(units.length - 1, Math.floor(Math.log2(Math.max(value, 1)) / 10));
  return `${Number((value / 1024 ** unit).toFixed(1))} ${units[unit]}`;
}
const join = (dir: string, name: string) => dir.replace(/\/$/, "") + "/" + name;

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
                <strong title={job.name}>{job.name}</strong>
                <span>
                  <span role="status">{label}</span>
                  {active &&
                    progress &&
                    ` · ${size(progress.bytes)} of ${size(progress.total)} · ${formatByteRate(progress.bytesPerSecond)}`}
                </span>
                {active && progress && (
                  <progress
                    aria-label={`Transfer progress for ${job.name}`}
                    value={progress.bytes}
                    max={Math.max(progress.total, 1)}
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
  const latestUpload = jobs
    .filter((job) => job.direction === "upload" && job.status === "complete")
    .at(-1)?.id;
  const [request, setRequest] = useState<{ path: string | null }>({ path: null });
  const [folder, setFolder] = useState<RemoteFolder | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [visibleCount, setVisibleCount] = useState(100);
  const [hidden, setHidden] = useState(false);
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
    setError("");
    void api
      .listTransferFolder(connection.id, request.path)
      .then(
        (result) => {
          if (current) {
            setFolder(result);
            setFilter("");
            setVisibleCount(100);
          }
        },
        (reason) => {
          if (current) setError(String(reason));
        },
      )
      .finally(() => {
        if (current) setBusy(false);
      });
    return () => {
      current = false;
    };
  }, [connection.id, request, latestUpload]);

  async function pick(name?: string) {
    if (!folder) return;
    try {
      const picked = await api.chooseTransferPaths(name ? "download" : "upload");
      if (!picked.length || !alive.current) return;
      if (name)
        enqueue(connection, "download", [
          { name, localPath: picked[0], remotePath: join(folder.path, name) },
        ]);
      else uploadFiles(connection, folder.path, picked);
    } catch (reason) {
      if (alive.current) setError(String(reason));
    }
  }
  const entries =
    folder?.entries.filter(
      (entry) =>
        (hidden || !entry.name.startsWith(".")) &&
        entry.name.toLowerCase().includes(filter.toLowerCase()),
    ) ?? [];
  const parent = folder?.path.replace(/\/[^/]+\/?$/, "") || "/";
  return (
    <section
      className="feature-page files-page"
      data-file-workspace={folder && !busy ? workspaceId : undefined}
      data-upload-folder={folder?.path}
    >
      <header className="page-heading compact-heading">
        <h2>Files</h2>
        <button className="secondary-button" onClick={() => void pick()} disabled={!folder || busy}>
          <ArrowUpFromLine size={15} /> Upload files
        </button>
      </header>
      {jobs.length > 0 && <Activity jobs={jobs} connection={connection} />}
      {error && (
        <div className="inline-error" role="alert">
          <span>{error}</span>
          <button className="inline-action" onClick={() => setRequest({ ...request })}>
            Try again
          </button>
        </div>
      )}
      {!folder && busy && (
        <Skeleton label="Reading remote folder">
          <Bone shape="control" width="100%" />
          <SkeletonRows count={6} />
        </Skeleton>
      )}
      {folder && (
        <div className="file-browser" aria-busy={busy}>
          <div className="file-location">
            <button
              className="icon-button"
              title="Home folder"
              aria-label="Home folder"
              disabled={busy}
              onClick={() => setRequest({ path: null })}
            >
              <House size={16} />
            </button>
            <button
              className="icon-button"
              title="Parent folder"
              aria-label="Parent folder"
              disabled={busy || folder.path === "/"}
              onClick={() => setRequest({ path: parent })}
            >
              <ArrowUp size={16} />
            </button>
            <code title={folder.path}>{folder.path}</code>
            <button
              className="icon-button"
              title="Refresh folder"
              aria-label="Refresh folder"
              disabled={busy}
              onClick={() => setRequest({ path: folder.path })}
            >
              <RefreshCw size={15} />
            </button>
          </div>
          <div className="file-filter">
            <label className="search-field">
              <Search size={15} />
              <input
                type="search"
                aria-label="Filter files"
                placeholder="Filter files"
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
          <ul className="file-list" aria-label="Remote files">
            {entries.slice(0, visibleCount).map((entry) => {
              const isFolder = entry.kind === "folder";
              const Icon = isFolder ? Folder : File;
              return (
                <li key={entry.name}>
                  <button
                    className="file-row"
                    disabled={busy || entry.kind === "other"}
                    aria-label={`${isFolder ? "Open folder" : "Download"} ${entry.name}`}
                    onClick={() =>
                      isFolder
                        ? setRequest({ path: join(folder.path, entry.name) })
                        : void pick(entry.name)
                    }
                  >
                    <Icon size={17} />
                    <span title={entry.name}>{entry.name}</span>
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
          {!entries.length && (
            <p className="files-empty">
              {filter
                ? "No matching files"
                : folder.entries.length
                  ? "No visible files"
                  : "This folder is empty"}
            </p>
          )}
          <footer className="file-drop-hint">
            <ArrowUpFromLine size={14} /> Drop local files here to upload
          </footer>
        </div>
      )}
    </section>
  );
}
