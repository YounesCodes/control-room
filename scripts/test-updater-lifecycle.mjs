// Real app, UI, HTTP feed, signature verification, NSIS replacement and restart.
// Only this disposable product's installation and data may be removed.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withInstalledApp } from "./lifecycle-driver.mjs";
import { seedLifecycleData, readLifecycleData, assertLifecycleData } from "./lifecycle-data.mjs";

assert.equal(process.platform, "win32", "The installed updater fixture currently requires NSIS");
const root = fileURLToPath(new URL("../", import.meta.url));
const identifier = "app.controlroom.updater-fixture";
assert.ok(process.env.APPDATA, "APPDATA is required");
const data = join(process.env.APPDATA, identifier);
if (process.argv.includes("--cleanup")) {
  const owned = resolve(readFileSync(join(data, ".updater-lifecycle-fixture"), "utf8"));
  assert.equal(dirname(owned), resolve(tmpdir()));
  assert.match(owned.split(/[\\/]/).at(-1), /^control-room-updater-lifecycle-[A-Za-z0-9]+$/);
  const application = join(owned, "application");
  stopOwnedApplication(join(application, "control-room.exe"));
  if (existsSync(join(application, "control-room.exe"))) {
    const uninstallers = readdirSync(application).filter((name) =>
      /^uninstall.*\.exe$/i.test(name),
    );
    assert.equal(uninstallers.length, 1);
    await run(join(application, uninstallers[0]), ["/S", `_?=${application}`]);
    assert.ok(!existsSync(join(application, "control-room.exe")));
  }
  rmSync(data, { recursive: true });
  rmSync(owned, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  console.log("Removed only the marked updater fixture and its native installation");
  process.exit(0);
}
assert.ok(!existsSync(data), `Refusing to replace existing fixture data: ${data}`);
const directory = mkdtempSync(join(tmpdir(), "control-room-updater-lifecycle-"));
const source = join(directory, "source");
const installRoot = join(directory, "application");
const application = join(installRoot, "control-room.exe");
const marker = join(data, ".updater-lifecycle-fixture");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const [major, minor, patch] = version.split(".").map(Number);
assert.ok(patch > 0, "Select a lower bootstrap version when starting a new minor release");
const previous = `${major}.${minor}.${patch - 1}`;
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const keyId = Buffer.from("0102030405060708", "hex");
const rawKey = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
const pubkey = Buffer.from(
  `untrusted comment: disposable updater lifecycle key\n${Buffer.concat([Buffer.from("Ed"), keyId, rawKey]).toString("base64")}\n`,
).toString("base64");
let payload,
  signature,
  modified = true,
  installed = false,
  passed = false;
let feedRequests = 0,
  packageRequests = 0;
const server = createServer((request, response) => {
  if (request.url === "/latest.json") {
    feedRequests++;
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        version,
        notes: "Local native updater lifecycle fixture",
        pub_date: "2026-01-01T00:00:00Z",
        platforms: { "windows-x86_64": { url: `${endpoint}/candidate.exe`, signature } },
      }),
    );
  } else if (request.url === "/candidate.exe" && payload) {
    packageRequests++;
    const bytes = Buffer.from(payload);
    if (modified) bytes[bytes.length - 1] ^= 1;
    response.setHeader("Content-Type", "application/octet-stream");
    response.setHeader("Content-Length", bytes.length);
    response.end(bytes);
  } else {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((done, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", done);
});
const endpoint = `http://127.0.0.1:${server.address().port}`;
try {
  mkdirSync(source);
  const archive = join(directory, "source.tar");
  execFileSync("git", ["archive", "HEAD", "--format=tar", "-o", archive], { cwd: root });
  execFileSync("tar", ["-xf", archive, "-C", source]);
  symlinkSync(join(root, "node_modules"), join(source, "node_modules"), "junction");
  // Build from disposable source; the lab checkout and production updater key
  // stay unchanged. The two binaries have genuinely different package versions.
  const originalCargo = readFileSync(join(source, "src-tauri/Cargo.toml"), "utf8");
  const originalConfig = JSON.parse(
    readFileSync(join(source, "src-tauri/tauri.conf.json"), "utf8"),
  );
  const target = join(root, "src-tauri/target");
  const installers = [];
  for (const current of [previous, version]) {
    writeFileSync(
      join(source, "src-tauri/Cargo.toml"),
      originalCargo.replace(/^(version\s*=\s*)"[^"]+"/m, `$1"${current}"`),
    );
    writeFileSync(
      join(source, "src-tauri/tauri.conf.json"),
      JSON.stringify(
        {
          ...originalConfig,
          version: current,
          identifier,
          productName: "Control Room Updater Fixture",
          plugins: {
            ...originalConfig.plugins,
            updater: {
              ...originalConfig.plugins.updater,
              pubkey,
              endpoints: [`${endpoint}/latest.json`],
              dangerousInsecureTransportProtocol: true,
              windows: { installMode: "quiet" },
            },
          },
        },
        null,
        2,
      ),
    );
    await run(
      process.execPath,
      [
        join(root, "node_modules/@tauri-apps/cli/tauri.js"),
        "build",
        "--debug",
        "--bundles",
        "nsis",
      ],
      {
        cwd: source,
        env: { ...process.env, CARGO_TARGET_DIR: target },
      },
    );
    const bundle = join(target, "debug/bundle/nsis");
    const matches = readdirSync(bundle).filter(
      (name) =>
        name.startsWith("Control Room Updater Fixture_") &&
        name.includes(`_${current}_`) &&
        name.endsWith(".exe"),
    );
    assert.equal(matches.length, 1, "Expected one isolated updater fixture installer");
    installers.push(join(directory, `${current}.exe`));
    writeFileSync(installers.at(-1), readFileSync(join(bundle, matches[0])));
  }
  payload = readFileSync(installers[1]);
  const signed = sign(null, createHash("blake2b512").update(payload).digest(), privateKey);
  const comment = `timestamp:123456\tfile:candidate.exe\tversion:${version}`;
  signature = Buffer.from(
    [
      "untrusted comment: disposable updater lifecycle signature",
      Buffer.concat([Buffer.from("ED"), keyId, signed]).toString("base64"),
      `trusted comment: ${comment}`,
      sign(null, Buffer.concat([signed, Buffer.from(comment)]), privateKey).toString("base64"),
      "",
    ].join("\n"),
  ).toString("base64");
  await run(installers[0], ["/S", `/D=${installRoot}`]);
  installed = true;
  assert.ok(existsSync(application));
  mkdirSync(data, { recursive: true });
  writeFileSync(marker, directory);
  const oldHash = hash(application);
  let expected;
  await withInstalledApp(
    application,
    async (invoke, session) => {
      assert.equal(await invoke("current_app_version"), previous);
      expected = await seedLifecycleData(invoke, session);
      await session.$('button[aria-label="Exit terminal focus"]').click();
      await session.waitUntil(() =>
        session.execute(() => !globalThis.document.documentElement.dataset.focusTransition),
      );
      await session.$('button[aria-label="Open Settings"]').click();
      await session.$("button=App & Diagnostics").click();
      await session.$("button=Check for updates").click();
      await session.$(".settings-update-status").waitForDisplayed({ timeout: 30000 });
      assert.equal(
        await session.$(".settings-update-status").getText(),
        `Version ${version} is available.`,
      );
      await session.$('button[aria-label="Close Settings"]').click();
      await session
        .$(`button[aria-label="Update available: Control Room ${version}"]`)
        .waitForDisplayed();
      await session.$(`button[aria-label="Update available: Control Room ${version}"]`).click();
      await session.$("button=Download update").click();
      await session.waitUntil(
        async () =>
          (await session.$("[role=dialog] [role=status]").getText()).includes(
            "The update signature did not verify, so it was not installed.",
          ),
        { timeout: 60000 },
      );
      assert.equal(
        hash(application),
        oldHash,
        "Bad signature must not replace the installed binary",
      );
      assert.equal(await invoke("current_app_version"), previous);
      assert.equal(await session.$("button=Restart to update").isExisting(), false);
      assert.equal(
        packageRequests,
        1,
        "Signature failure must follow a real HTTP package download",
      );
      console.log(
        "Actual app UI rejected modified signed bytes; original installed binary is unchanged",
      );
      modified = false;
      await session.$("button=Try again").click();
      await session.$("button=Restart to update").waitForDisplayed({ timeout: 60000 });
      await session.$("button=Restart to update").click();
      await session.$("button=Restart and update").click();
      // The original process exits; replacement and launch are verified below.
    },
    { applicationExits: true },
  );
  await until(
    () => existsSync(application) && hash(application) !== oldHash,
    "Signed updater did not replace the executable",
    120000,
  );
  const candidateExe = join(target, "debug/control-room.exe");
  assert.equal(
    hash(application),
    hash(candidateExe),
    "Installed bytes must match the signed candidate build",
  );
  await until(
    () => ownedProcesses().some((process) => process.MainWindowHandle !== 0),
    "Installer did not automatically launch a window for the updated application",
    60000,
  );
  console.log(
    "Signed update replaced the native installation and automatically launched its window",
  );
  stopOwnedApplication();
  await withInstalledApp(application, async (invoke, session) => {
    assert.equal(await invoke("current_app_version"), version);
    await session.waitUntil(
      () =>
        session.execute(
          () => globalThis.document.querySelectorAll(".session-tab-wrap").length === 2,
        ),
      { timeout: 30000 },
    );
    assertLifecycleData(expected, await readLifecycleData(invoke, expected.connections[0].id));
  });
  assert.ok(feedRequests >= 1);
  assert.equal(packageRequests, 2, "Both modified and valid payloads must use the local feed");
  passed = true;
  console.log(
    `Real app updater ${previous} -> ${version}: bad signature refused, signed install/restart and all user data passed`,
  );
} catch (error) {
  console.error(`Updater lifecycle failed: ${error.stack ?? error}`);
  writeFileSync(join(directory, "failure.txt"), String(error.stack ?? error));
  throw error;
} finally {
  await new Promise((done) => server.close(done));
  if (installed) {
    stopOwnedApplication();
    const uninstallers = readdirSync(installRoot).filter((name) =>
      /^uninstall.*\.exe$/i.test(name),
    );
    assert.equal(uninstallers.length, 1);
    await run(join(installRoot, uninstallers[0]), ["/S", `_?=${installRoot}`]);
    assert.ok(!existsSync(application), "Owned updater fixture was not uninstalled");
  }
  if (existsSync(data)) {
    assert.equal(readFileSync(marker, "utf8"), directory, "Refusing unowned fixture cleanup");
    rmSync(data, { recursive: true });
  }
  if (passed) {
    assert.equal(dirname(directory), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } else console.error(`Updater fixture source and logs preserved at ${directory}`);
}

function hash(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
function run(command, args, options = {}) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? done() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}
async function until(check, message, timeout) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((done) => setTimeout(done, 250));
  }
}
function ownedProcesses() {
  const escaped = application.replaceAll("'", "''");
  const result = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `@((Get-Process -Name control-room -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${escaped}' }) | Select-Object Id,MainWindowHandle) | ConvertTo-Json -Compress`,
    ],
    { encoding: "utf8" },
  ).trim();
  const parsed = result ? JSON.parse(result) : [];
  return Array.isArray(parsed) ? parsed : [parsed];
}
function stopOwnedApplication(file = application) {
  const escaped = file.replaceAll("'", "''");
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `$ErrorActionPreference = 'Stop'; Get-Process -Name control-room -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${escaped}' } | ForEach-Object { Stop-Process -Id $_.Id -Force; $_.WaitForExit(10000) | Out-Null }; exit 0`,
    ],
    { stdio: "inherit" },
  );
}
