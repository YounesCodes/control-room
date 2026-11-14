import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { linuxProcesses } from "../e2e/linux-processes";

it.skipIf(process.platform !== "linux")(
  "identifies a real child and stops reporting it after exit",
  async () => {
    const child = spawn("/usr/bin/sleep", ["10"]);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      const identity = linuxProcesses().find((row) => row.id === child.pid)!;
      expect(identity.parent).toBe(process.pid);
      expect(identity.created).toMatch(/^\d+$/);
      expect(identity.executable).toBe("/usr/bin/sleep");
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
      expect(linuxProcesses().some((row) => row.id === child.pid)).toBe(false);
    } finally {
      child.kill();
    }
  },
);
