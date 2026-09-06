import { decodeBase64Utf8 } from "./format";

const MAX_HISTORY_OSC_CHARS = 1_500_000;
const MAX_HISTORY_COMMAND_BYTES = 1024 * 1024;
const MAX_HISTORY_CWD_BYTES = 32_767;

type HistoryOscEvent =
  | { kind: "start"; startedAt: string; cwd: string | null; command: string }
  | { kind: "finish"; finishedAt: string; exitCode: number; cwd: string | null };

export function isControlRoomConnectedOsc(data: string): boolean {
  return data === "ControlRoom;connected";
}

export function parseHistoryOsc(data: string): HistoryOscEvent | null {
  if (!data.startsWith("ControlRoom;") || data.length > MAX_HISTORY_OSC_CHARS) return null;
  const parts = data.split(";");
  if (parts.length !== 5) return null;
  try {
    if (parts[1] === "start") {
      const command = decodeBase64Utf8(parts[4]);
      const cwd = decodeBase64Utf8(parts[3]);
      if (
        !command.trim() ||
        new TextEncoder().encode(command).byteLength > MAX_HISTORY_COMMAND_BYTES ||
        new TextEncoder().encode(cwd).byteLength > MAX_HISTORY_CWD_BYTES
      ) {
        return null;
      }
      const startedAt = strictEpochTimestamp(parts[2]);
      return startedAt ? { kind: "start", startedAt, cwd: cwd || null, command } : null;
    }
    if (parts[1] === "finish") {
      const finishedAt = strictEpochTimestamp(parts[2]);
      const exitCode = strictExitStatus(parts[3]);
      const cwd = decodeBase64Utf8(parts[4]);
      if (
        !finishedAt ||
        exitCode === null ||
        new TextEncoder().encode(cwd).byteLength > MAX_HISTORY_CWD_BYTES
      ) {
        return null;
      }
      return { kind: "finish", finishedAt, exitCode, cwd: cwd || null };
    }
  } catch {
    return null;
  }
  return null;
}

/// The shell integration emits `$?`, which is a plain decimal number. `Number`
/// reads a good deal more than that: an empty field becomes 0, so a finish that
/// carried no status was recorded as a success; `0x10` becomes 16, `1e3`
/// becomes 1000, and surrounding whitespace is ignored. None of those are
/// things bash writes, so reading them is inventing an exit code for a record
/// the user later searches by.
function strictExitStatus(value: string): number | null {
  if (!/^\d{1,10}$/.test(value)) return null;
  const status = Number(value);
  return status <= 2_147_483_647 ? status : null;
}

function strictEpochTimestamp(value: string): string | null {
  if (!/^\d{1,16}$/.test(value)) return null;
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) return null;
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    return null;
  }
}
