import { Channel, invoke } from "@tauri-apps/api/core";
import { connectionTargetKey } from "./connection-validation";
import type { SavedConnection } from "../types";

export interface RemoteFolder {
  path: string;
  entries: { name: string; kind: "folder" | "file" | "other"; size: number | null }[];
}

export const listFolder = (connectionId: string, folder: string | null) =>
  invoke<RemoteFolder>("list_transfer_folder", { connectionId, folder });

type Direction = "upload" | "download";
interface Progress {
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
  progress?: Progress;
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
    const progress = new Channel<Progress>();
    progress.onmessage = (value) => {
      const current = jobs.find((item) => item.id === job.id);
      if (current?.status === "active") update(job.id, { progress: value });
      if (current?.status === "canceling") void requestCancel(job.id);
    };
    const { destination, username, port, identityFile } = job.connection;
    const outcome = await invoke<"complete" | "exists">("transfer_file", {
      connectionId: job.connection.id,
      expectedTarget: [destination, username, port, identityFile],
      spec: {
        id: job.id,
        direction: job.direction,
        remotePath: job.remotePath,
        localPath: job.localPath,
        replace: job.replace,
      },
      progress,
    });
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
    await invoke("cancel_transfer", { id });
  } catch (error) {
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
