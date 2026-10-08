import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface DriverProcess {
  id: number;
  parent: number;
  created: string;
  name: string;
}

function drivers(): DriverProcess[] {
  try {
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$rows = @(Get-CimInstance Win32_Process -Filter \"Name='tauri-driver.exe' OR Name='msedgedriver.exe' OR Name='cmd.exe'\" | ForEach-Object { @{ id = $_.ProcessId; parent = $_.ParentProcessId; name = $_.Name; created = $_.CreationDate.ToUniversalTime().ToString('o') } }); ConvertTo-Json -Compress -InputObject $rows",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    const parsed = output.trim() ? JSON.parse(output) : [];
    return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch {
    console.error("Could not inspect desktop driver processes; preserving unverified processes.");
    return [];
  }
}

export function recordDrivers(directory: string, runnerPid: number) {
  const snapshot = drivers();
  const roots = snapshot.filter(
    (driver) =>
      driver.name === "tauri-driver.exe" &&
      (driver.parent === runnerPid ||
        snapshot.some(
          (bridge) =>
            bridge.name === "cmd.exe" && bridge.id === driver.parent && bridge.parent === runnerPid,
        )),
  );
  const owned = snapshot.filter(
    (driver) =>
      roots.includes(driver) ||
      roots.some((root) => driver.parent === root.id || root.parent === driver.id),
  );
  appendFileSync(join(directory, "driver-pids.jsonl"), `${JSON.stringify(owned)}\n`);
}

export async function stopOwnedDrivers(directory: string) {
  const file = join(directory, "driver-pids.jsonl");
  if (!existsSync(file)) return;
  const owned: DriverProcess[] = readFileSync(file, "utf8")
    .trim()
    .split(/\r?\n/)
    .flatMap((line) => JSON.parse(line));
  const snapshot = drivers();
  // Match creation time as well as PID so a reused PID cannot target another process.
  const remaining = snapshot.filter((driver) =>
    owned.some((record) => record.id === driver.id && record.created === driver.created),
  );
  for (const driver of remaining.reverse()) {
    try {
      process.kill(driver.id);
    } catch {
      // The service may have already stopped this driver.
    }
  }
  const deadline = Date.now() + 20_000;
  for (const driver of remaining) {
    while (true) {
      try {
        process.kill(driver.id, 0);
      } catch {
        break;
      }
      if (Date.now() > deadline) throw new Error(`Owned driver ${driver.id} did not exit`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
