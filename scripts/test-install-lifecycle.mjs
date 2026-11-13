// Explicit native package test. Run only in a disposable desktop account.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { releaseAsset, previousRelease } from "./lifecycle-releases.mjs";
import { withInstalledApp } from "./lifecycle-driver.mjs";
import { seedLifecycleData, readLifecycleData, assertLifecycleData } from "./lifecycle-data.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const dataRoot =
  process.platform === "win32"
    ? join(required("APPDATA"), "app.controlroom.desktop")
    : process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support", "app.controlroom.desktop")
      : join(
          process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
          "app.controlroom.desktop",
        );
if (process.argv.includes("--cleanup")) {
  const marker = join(dataRoot, ".lifecycle-fixture");
  assert.ok(existsSync(marker), "Refusing cleanup without this runner's ownership marker");
  const owned = resolve(readFileSync(marker, "utf8"));
  assert.equal(
    dirname(owned),
    resolve(tmpdir()),
    "Fixture must be in the current user's temp directory",
  );
  assert.match(basename(owned), /^control-room-install-lifecycle-[A-Za-z0-9]+$/);
  if (process.platform === "win32") {
    const application = join(owned, "application");
    if (existsSync(join(application, "control-room.exe"))) {
      const uninstallers = readdirSync(application).filter((name) =>
        /^uninstall.*\.exe$/i.test(name),
      );
      assert.equal(uninstallers.length, 1);
      execFileSync(join(application, uninstallers[0]), ["/S", `_?=${application}`], {
        stdio: "inherit",
        timeout: 180000,
      });
      assert.ok(
        !existsSync(join(application, "control-room.exe")),
        "Owned application is still installed",
      );
    }
  } else if (process.platform === "linux") {
    if (existsSync("/usr/bin/control-room")) {
      const receipt = JSON.parse(readFileSync(join(owned, "installed.json"), "utf8"));
      assert.equal(
        receipt.sha256,
        binaryHash("/usr/bin/control-room"),
        "Refusing to uninstall a binary changed since the fixture installed it",
      );
      execFileSync("sudo", ["apt-get", "remove", "-y", "control-room"], {
        stdio: "inherit",
        timeout: 180000,
      });
    }
  } else assert.fail("Installed macOS cleanup needs the native lifecycle adapter");
  rmSync(dataRoot, { recursive: true });
  rmSync(owned, { recursive: true, force: true });
  console.log("Removed only the marked lifecycle fixture and its installation");
  process.exit(0);
}
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const response = await fetch(
  "https://api.github.com/repos/YounesCodes/control-room/releases?per_page=100",
  {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(30000),
  },
);
assert.ok(response.ok, `GitHub release lookup failed: ${response.status}`);
const fromFlag = process.argv.indexOf("--from");
if (fromFlag !== -1) assert.ok(process.argv[fromFlag + 1], "--from requires a release version");
const previous = previousRelease(
  await response.json(),
  version,
  fromFlag === -1 ? process.env.CONTROL_ROOM_LIFECYCLE_FROM : process.argv[fromFlag + 1],
);
const asset = releaseAsset(previous, process.platform);
console.log(`Published upgrade source: ${previous.tag_name} / ${asset.name}`);
if (process.argv.includes("--preflight")) process.exit(0);
assert.notEqual(
  process.platform,
  "darwin",
  "Published macOS WKWebViews need an accessibility adapter; external tauri-driver cannot automate them",
);

assert.ok(
  !existsSync(dataRoot),
  `Refusing to overwrite existing user data: ${dataRoot}. Use a clean lab account.`,
);
if (process.platform === "win32") {
  for (const folder of [
    join(required("LOCALAPPDATA"), "Control Room"),
    join(required("LOCALAPPDATA"), "Programs", "Control Room"),
  ]) {
    assert.ok(!existsSync(folder), `Refusing to replace an existing installation: ${folder}`);
  }
} else if (process.platform === "linux")
  assert.ok(
    !existsSync("/usr/bin/control-room"),
    "Refusing to replace an existing Linux installation",
  );
const directory = mkdtempSync(join(tmpdir(), "control-room-install-lifecycle-"));
const installRoot = join(directory, "application");
const application =
  process.platform === "win32" ? join(installRoot, "control-room.exe") : "/usr/bin/control-room";
let success = false,
  installed = false;
try {
  const download = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(120000) });
  assert.ok(download.ok, `Published package download failed: ${download.status}`);
  const oldPackage = join(directory, asset.name);
  writeFileSync(oldPackage, new Uint8Array(await download.arrayBuffer()));
  const candidateFlag = process.argv.indexOf("--candidate");
  let candidate;
  if (candidateFlag !== -1) {
    assert.ok(process.argv[candidateFlag + 1], "--candidate requires an installer path");
    candidate = resolve(process.argv[candidateFlag + 1]);
  } else {
    const bundle = process.platform === "win32" ? "nsis" : "deb";
    execFileSync(
      process.execPath,
      [join(root, "node_modules/@tauri-apps/cli/tauri.js"), "build", "--bundles", bundle],
      {
        cwd: root,
        stdio: "inherit",
        timeout: 1200000,
      },
    );
    const folder = join(root, "src-tauri/target/release/bundle", bundle);
    const extension = process.platform === "win32" ? ".exe" : ".deb";
    const matches = readdirSync(folder).filter(
      (name) => name.includes(version) && name.endsWith(extension),
    );
    assert.equal(matches.length, 1, "Expected exactly one branch installer");
    candidate = join(folder, matches[0]);
  }
  assert.ok(existsSync(candidate), `Candidate installer does not exist: ${candidate}`);
  execFileSync(
    "cargo",
    [
      "test",
      "--locked",
      "--manifest-path",
      join(root, "src-tauri/Cargo.toml"),
      "--test",
      "updater_http",
      "modified_installer_cannot_reach_installation",
      "--",
      "--nocapture",
    ],
    { cwd: root, stdio: "inherit", timeout: 600000 },
  );
  if (process.platform === "win32")
    execFileSync(process.execPath, [join(root, "scripts/test-updater-install.mjs")], {
      cwd: root,
      stdio: "inherit",
      timeout: 600000,
    });
  mkdirSync(dataRoot, { recursive: true });
  writeFileSync(join(dataRoot, ".lifecycle-fixture"), directory);
  const publishedHash = install(oldPackage);
  installed = true;
  const expected = await withInstalledApp(application, async (invoke, session) => {
    assert.equal(await invoke("current_app_version"), previous.tag_name.replace(/^v/, ""));
    return seedLifecycleData(invoke, session);
  });
  const oldSchema = inspectDatabase();
  // The version alone cannot prove replacement when the branch still carries
  // the published version number.
  assert.notEqual(
    install(candidate),
    publishedHash,
    "The candidate installer left the published executable in place",
  );
  await withInstalledApp(application, async (invoke, session) => {
    assert.equal(await invoke("current_app_version"), version);
    await session.waitUntil(() =>
      session.execute(() => globalThis.document.querySelectorAll(".session-tab-wrap").length === 2),
    );
    assertLifecycleData(expected, await readLifecycleData(invoke, expected.connections[0].id));
  });
  const upgradedSchema = inspectDatabase();
  assert.ok(
    upgradedSchema.version >= oldSchema.version,
    "Upgrade must never downgrade the database schema",
  );
  assert.equal(
    upgradedSchema.legacyBaselines,
    false,
    "Upgrade must apply the retired Baselines table migration",
  );
  console.log(
    `Installed ${previous.tag_name} -> ${version}; all user data survived; schema ${oldSchema.version} -> ${upgradedSchema.version}; legacy table ${oldSchema.legacyBaselines} -> ${upgradedSchema.legacyBaselines}`,
  );

  uninstall();
  installed = false;
  // This directory was absent before the run and contains only this fixture's data.
  assert.equal(readFileSync(join(dataRoot, ".lifecycle-fixture"), "utf8"), directory);
  rmSync(dataRoot, { recursive: true });
  install(candidate);
  installed = true;
  await withInstalledApp(application, async (invoke) => {
    assert.equal(await invoke("current_app_version"), version);
    for (const command of ["list_connections", "list_connection_groups", "list_connection_tags"])
      assert.deepEqual(await invoke(command), []);
    assert.equal(
      await invoke("get_scratchpad_note", {
        scope: "global",
        ownerId: "global",
        connectionId: null,
      }),
      null,
    );
    assert.deepEqual((await invoke("get_workspace_state")).workspaces, []);
    const settings = await invoke("get_settings_contract");
    assert.deepEqual(settings.current, settings.defaults);
  });
  inspectDatabase();
  uninstall();
  installed = false;
  success = true;
  console.log("Clean uninstall/reinstall launched with default settings and no prior data");
} finally {
  if (success) {
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  } else {
    console.error(
      `Lifecycle failure preserved fixture at ${directory}; user data at ${dataRoot}; installed=${installed}`,
    );
  }
}

function required(name) {
  assert.ok(process.env[name], `${name} is required`);
  return process.env[name];
}
function install(file) {
  if (process.platform === "win32") {
    assert.ok(!/\s/.test(installRoot), "NSIS fixture installation path must not contain spaces");
    execFileSync(file, ["/S", `/D=${installRoot}`], { stdio: "inherit", timeout: 180000 });
  } else
    execFileSync("sudo", ["apt-get", "install", "-y", "--reinstall", resolve(file)], {
      stdio: "inherit",
      timeout: 180000,
    });
  assert.ok(existsSync(application), "Installer did not produce the application binary");
  const sha256 = binaryHash(application);
  writeFileSync(join(directory, "installed.json"), JSON.stringify({ sha256 }));
  return sha256;
}
function binaryHash(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
function uninstall() {
  if (process.platform === "win32") {
    const matches = readdirSync(installRoot).filter((name) => /^uninstall.*\.exe$/i.test(name));
    assert.equal(matches.length, 1, "Expected the installed NSIS uninstaller");
    // Disable NSIS's temporary self-copy so the process we wait for owns removal.
    execFileSync(join(installRoot, matches[0]), ["/S", `_?=${installRoot}`], {
      stdio: "inherit",
      timeout: 180000,
    });
  } else
    execFileSync("sudo", ["apt-get", "remove", "-y", "control-room"], {
      stdio: "inherit",
      timeout: 180000,
    });
  assert.ok(!existsSync(application), "Uninstaller left the application binary installed");
}
function inspectDatabase() {
  const db = new DatabaseSync(join(dataRoot, "control-room.db"), { readOnly: true });
  try {
    assert.equal(Object.values(db.prepare("PRAGMA integrity_check").get())[0], "ok");
    return {
      version: Object.values(db.prepare("PRAGMA user_version").get())[0],
      legacyBaselines: Boolean(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='host_baselines'")
          .get(),
      ),
    };
  } finally {
    db.close();
  }
}
