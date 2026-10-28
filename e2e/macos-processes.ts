import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { application, isMac } from "./platform";

function identity(pid: number): string | null {
  try {
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "args="], {
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

export function recordMacApplication(directory: string, pid: number) {
  if (!isMac) return;
  const created = identity(pid);
  if (!created?.includes(application))
    throw new Error("Refusing to record an unrelated application");
  appendFileSync(
    join(directory, "mac-app-processes.jsonl"),
    JSON.stringify({ pid, created }) + "\n",
  );
}

export async function stopOwnedMacApplications(directory: string) {
  const file = join(directory, "mac-app-processes.jsonl");
  if (!isMac || !existsSync(file)) return;
  const records: { pid: number; created: string }[] = readFileSync(file, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  for (const { pid, created } of records) {
    // A PID from a dead worker alone is insufficient proof of ownership.
    if (identity(pid) !== created) continue;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* Already exited. */
    }
    const deadline = Date.now() + 20_000;
    while (identity(pid) === created) {
      if (Date.now() > deadline)
        throw new Error(`Owned macOS test application ${pid} did not exit`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
