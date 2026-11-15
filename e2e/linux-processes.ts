import { readdirSync, readFileSync, readlinkSync } from "node:fs";

export interface LinuxProcess {
  id: number;
  parent: number;
  created: string;
  name: string;
  executable: string;
}

// /proc start ticks distinguish a reused PID. Ignore zombies, which own no resources.
export function linuxProcesses(): LinuxProcess[] {
  return readdirSync("/proc")
    .filter((entry) => /^\d+$/.test(entry))
    .flatMap((entry) => {
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        const end = stat.lastIndexOf(")");
        const fields = stat.slice(end + 2).split(" ");
        if (fields[0] === "Z") return [];
        return [
          {
            id: Number(entry),
            parent: Number(fields[1]),
            created: fields[19],
            name: stat.slice(stat.indexOf("(") + 1, end),
            executable: readlinkSync(`/proc/${entry}/exe`),
          },
        ];
      } catch (error) {
        if (["ENOENT", "EACCES", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? ""))
          return [];
        throw error;
      }
    });
}
