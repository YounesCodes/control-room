// Launch the release AppImage with isolated user data and use it for real work.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withInstalledApp } from "./lifecycle-driver.mjs";
import { seedLifecycleData } from "./lifecycle-data.mjs";

assert.equal(process.platform, "linux");
const [appimage, version] = process.argv.slice(2);
assert.ok(appimage && version, "usage: test-linux-appimage-launch.mjs <AppImage> <version>");
const directory = mkdtempSync(join(tmpdir(), "control-room-appimage-launch-"));
for (const name of ["DATA", "CONFIG", "CACHE", "STATE"])
  process.env[`XDG_${name}_HOME`] = join(directory, name.toLowerCase());
let passed = false;
try {
  await withInstalledApp(resolve(appimage), async (invoke, session) => {
    assert.equal(await invoke("current_app_version"), version);
    assert.deepEqual(await invoke("list_connections"), []);
    // Real SQLite writes, a UI-created split and live shell input.
    const seeded = await seedLifecycleData(invoke, session);
    assert.equal(seeded.workspace.workspaces.length, 2);
  });
  passed = true;
  console.log(`Release AppImage ${version} launched, saved data and ran local shells`);
} finally {
  if (passed) rmSync(directory, { recursive: true });
  else console.error(`Preserved AppImage launch data at ${directory}`);
}
