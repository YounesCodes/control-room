import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface ApplicationProcess {
  id: number;
  created: string;
  executable: string;
}

function applications(): ApplicationProcess[] {
  const output = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$rows = @(Get-CimInstance Win32_Process -Filter \"Name='control-room.exe'\" -ErrorAction Stop | ForEach-Object { @{ id = $_.ProcessId; created = $_.CreationDate.ToUniversalTime().ToString('o'); executable = $_.ExecutablePath } }); ConvertTo-Json -Compress -InputObject $rows",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  const parsed: unknown = JSON.parse(output);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  if (
    rows.some(
      (row) =>
        !row ||
        !Number.isInteger(row.id) ||
        row.id <= 0 ||
        typeof row.created !== "string" ||
        !row.created ||
        typeof row.executable !== "string" ||
        !row.executable,
    )
  ) {
    throw new Error(
      "Could not verify desktop application process identities; preserving test data",
    );
  }
  return rows;
}

function sameApplication(left: ApplicationProcess, right: ApplicationProcess) {
  return (
    left.id === right.id &&
    left.created === right.created &&
    resolve(left.executable).toLowerCase() === resolve(right.executable).toLowerCase()
  );
}

export function recordApplication(directory: string, pid: number, executable: string) {
  const application = applications().find(
    (row) =>
      row.id === pid && resolve(row.executable).toLowerCase() === resolve(executable).toLowerCase(),
  );
  if (!application) throw new Error(`Could not verify E2E application ${pid}`);
  appendFileSync(join(directory, "app-processes.jsonl"), `${JSON.stringify(application)}\n`);
}

export async function waitForRecordedApplications(directory: string, timeoutMs = 20_000) {
  const file = join(directory, "app-processes.jsonl");
  if (!existsSync(file)) return;
  const records: ApplicationProcess[] = readFileSync(file, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = applications().filter((current) =>
      records.some((record) => sameApplication(record, current)),
    );
    if (!remaining.length) return;
    if (Date.now() >= deadline)
      throw new Error(
        `E2E application ${remaining[0].id} is still running; preserving its temporary directory`,
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
