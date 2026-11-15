// Explicit Linux package lifecycle with isolated user data and package restore.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withInstalledApp } from "./lifecycle-driver.mjs";
import { seedLifecycleData } from "./lifecycle-data.mjs";

assert.equal(process.platform, "linux");
const candidate = resolve(required("--candidate"));
const restore = resolve(required("--restore"));
const version = required("--version");
const application = "/usr/bin/control-room";
assert.ok(existsSync(application), "Use the full lifecycle runner for a fresh VM");
const directory = mkdtempSync(join(tmpdir(), "control-room-linux-install-clean-"));
const originalHash = hash(application);
let candidateHash,
  changed = false,
  passed = false;
try {
  // Prove that the supplied restore package contains the currently installed
  // executable before allowing apt to replace anything.
  execFileSync("dpkg-deb", ["-x", restore, join(directory, "restore")]);
  assert.equal(
    hash(join(directory, "restore/usr/bin/control-room")),
    originalHash,
    "Restore package does not match the existing installation",
  );
  execFileSync("dpkg-deb", ["-x", candidate, join(directory, "candidate")]);
  candidateHash = hash(join(directory, "candidate/usr/bin/control-room"));
  for (const name of ["DATA", "CONFIG", "CACHE", "STATE"])
    process.env[`XDG_${name}_HOME`] = join(directory, name.toLowerCase());
  const data = join(process.env.XDG_DATA_HOME, "app.controlroom.desktop");
  writeFileSync(join(directory, ".owned"), originalHash);
  changed = true;
  install(candidate);
  assert.equal(hash(application), candidateHash);
  await withInstalledApp(application, async (invoke, session) => {
    assert.equal(await invoke("current_app_version"), version);
    const seeded = await seedLifecycleData(invoke, session);
    assert.equal(seeded.connections.length, 1);
    assert.equal(seeded.workspace.workspaces.length, 2);
  });
  assert.ok(existsSync(join(data, "control-room.db")), "App must use the isolated XDG database");
  execFileSync("sudo", ["-n", "apt-get", "remove", "-y", "control-room"], {
    stdio: "inherit",
    timeout: 180000,
  });
  assert.ok(!existsSync(application), "Uninstall must remove the native executable");
  assert.equal(readFileSync(join(directory, ".owned"), "utf8"), originalHash);
  rmSync(process.env.XDG_DATA_HOME, { recursive: true });
  install(candidate);
  await withInstalledApp(application, async (invoke) => {
    assert.equal(await invoke("current_app_version"), version);
    for (const command of ["list_connections", "list_connection_groups", "list_connection_tags"])
      assert.deepEqual(await invoke(command), []);
    assert.deepEqual((await invoke("get_workspace_state")).workspaces, []);
    assert.equal(
      await invoke("get_scratchpad_note", {
        scope: "global",
        ownerId: "global",
        connectionId: null,
      }),
      null,
    );
    const settings = await invoke("get_settings_contract");
    assert.deepEqual(settings.current, settings.defaults);
  });
  passed = true;
  console.log(
    "Linux native .deb uninstall/reinstall passed with real seeded data and clean defaults",
  );
} finally {
  if (changed) {
    if (existsSync(application))
      assert.ok(
        [originalHash, candidateHash].includes(hash(application)),
        "Refusing to replace an executable changed outside this fixture",
      );
    install(restore);
    assert.equal(hash(application), originalHash, "Original installed binary was not restored");
    console.log(
      "Restored the original Linux package and binary; existing user data was outside the fixture",
    );
  }
  if (passed) rmSync(directory, { recursive: true });
  else console.error(`Preserved isolated Linux lifecycle data at ${directory}`);
}
function required(flag) {
  const index = process.argv.indexOf(flag);
  assert.ok(index !== -1 && process.argv[index + 1], `${flag} is required`);
  return process.argv[index + 1];
}
function hash(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
function install(file) {
  execFileSync(
    "sudo",
    ["-n", "apt-get", "install", "-y", "--reinstall", "--allow-downgrades", file],
    {
      stdio: "inherit",
      timeout: 180000,
    },
  );
}
