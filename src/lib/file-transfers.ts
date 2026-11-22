import { Channel } from "@tauri-apps/api/core";
import { api } from "./api";
import { connectionTargetKey } from "./connection-validation";
import type { SavedConnection } from "../types";

export interface RemoteFolder {
  path: string;
  entries: { name: string; kind: "folder" | "file" | "other"; size: number | null }[];
}

type Direction = "upload" | "download";
export interface TransferProgress {
  bytes: number;
  total: number;
  bytesPerSecond: number;
}

export interface FileJob {
  id: string;
  connection: SavedConnection;
  name: string;
  localPath: string;
  remotePath: string;
  direction: Direction;
  status: "queued" | "active" | "canceling" | "exists" | "complete" | "failed" | "canceled";
  progress?: TransferProgress;
  error?: string;
  replace: boolean;
}

let jobs: FileJob[] = [];
const listeners = new Set<() => void>();
export const fileJobs = () => jobs;
export const subscribeFileJobs = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
function publish(next: FileJob[]) {
  jobs = next;
  for (const listener of listeners) listener();
}
function update(id: string, patch: Partial<FileJob>) {
  publish(jobs.map((job) => (job.id === id ? { ...job, ...patch } : job)));
}
export function belongsTo(job: FileJob, connection: SavedConnection) {
  return (
    job.connection.id === connection.id &&
    connectionTargetKey(job.connection) === connectionTargetKey(connection)
  );
}
export function clearFinished(connection: SavedConnection) {
  publish(
    jobs.filter(
      (job) =>
        !belongsTo(job, connection) || !["complete", "canceled", "failed"].includes(job.status),
    ),
  );
}

function pump() {
  const job = jobs.find((item) => item.status === "queued");
  if (!job || jobs.some((item) => item.status === "active" || item.status === "canceling")) return;
  update(job.id, { status: "active" });
  void run(job).finally(pump);
}
async function run(job: FileJob) {
  try {
    const progress = new Channel<TransferProgress>();
    progress.onmessage = (value) => {
      const current = jobs.find((item) => item.id === job.id);
      if (current?.status === "active") update(job.id, { progress: value });
      if (current?.status === "canceling") void requestCancel(job.id);
    };
    const outcome = await api.transferFile(job, progress);
    update(job.id, {
      status:
        outcome === "exists" && jobs.find((item) => item.id === job.id)?.status === "canceling"
          ? "canceled"
          : outcome,
    });
  } catch (error) {
    const reason = String(error);
    update(job.id, {
      status: reason === "Transfer canceled." ? "canceled" : "failed",
      error: reason,
    });
  }
}
export function enqueue(
  connection: SavedConnection,
  direction: Direction,
  files: { name: string; localPath: string; remotePath: string }[],
) {
  publish([
    ...jobs,
    ...files.map((file) => ({
      ...file,
      id: crypto.randomUUID(),
      connection,
      direction,
      replace: false,
      status: "queued" as const,
    })),
  ]);
  pump();
}
export function uploadFiles(connection: SavedConnection, folder: string, paths: string[]) {
  enqueue(
    connection,
    "upload",
    paths.map((localPath) => ({
      localPath,
      remotePath: folder,
      name: localPath.startsWith("/")
        ? localPath.split("/").pop()!
        : localPath.split(/[\\/]/).pop()!,
    })),
  );
}
async function requestCancel(id: string) {
  try {
    await api.cancelTransfer(id);
  } catch (error) {
    if (jobs.find((job) => job.id === id)?.status === "canceling")
      update(id, { status: "active", error: String(error) });
  }
}
export function cancelJob(id: string) {
  const job = jobs.find((item) => item.id === id);
  if (job?.status === "active") {
    update(id, { status: "canceling" });
    void requestCancel(id);
  } else if (job && ["queued", "exists"].includes(job.status)) update(id, { status: "canceled" });
}
export function replaceJob(id: string) {
  if (jobs.find((job) => job.id === id)?.status !== "exists") return;
  update(id, { status: "queued", replace: true });
  pump();
}
