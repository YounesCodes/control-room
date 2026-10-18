// Runs a signed NSIS replacement through the real updater in a child process.
// All files stay in an owned temporary directory; the user's app is untouched.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32")
  throw new Error("This test requires Windows and the NSIS compiler");
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = mkdtempSync(join(resolve(tmpdir()), "control-room-updater-install-"));
function cleanup() {
  if (
    dirname(directory) !== resolve(tmpdir()) ||
    !basename(directory).startsWith("control-room-updater-install-")
  )
    throw new Error("Refusing to remove a directory outside the updater fixture");
  rmSync(directory, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
}
try {
  const payload = join(directory, "payload.txt");
  const installer = join(directory, "fixture.exe");
  writeFileSync(payload, "updated fixture version\n");
  const compiler =
    process.env.CONTROL_ROOM_MAKENSIS_EXE ??
    join(process.env.LOCALAPPDATA, "tauri/NSIS/makensis.exe");
  execFileSync(
    compiler,
    [
      "/V2",
      `/DOUTPUT=${installer}`,
      `/DPAYLOAD=${payload}`,
      join(root, "src-tauri/test-fixtures/updater-install.nsi"),
    ],
    { stdio: "inherit", timeout: 30_000 },
  );
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const id = Buffer.from("0102030405060708", "hex");
  const rawKey = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const signature = sign(
    null,
    createHash("blake2b512").update(readFileSync(installer)).digest(),
    privateKey,
  );
  const comment = "timestamp:123456\tfile:fixture.exe\tversion:1.0.0";
  const encoded = Buffer.from(
    [
      "untrusted comment: disposable installation test",
      Buffer.concat([Buffer.from("ED"), id, signature]).toString("base64"),
      `trusted comment: ${comment}`,
      sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey).toString("base64"),
      "",
    ].join("\n"),
  ).toString("base64");
  const key = Buffer.from(
    `untrusted comment: disposable test public key\n${Buffer.concat([Buffer.from("Ed"), id, rawKey]).toString("base64")}\n`,
  ).toString("base64");
  const fixture = join(directory, "fixture.json");
  writeFileSync(
    fixture,
    JSON.stringify({ payloadPath: installer, pubkey: key, signature: encoded }),
  );
  execFileSync(
    "cargo",
    [
      "test",
      "--locked",
      "--manifest-path",
      join(root, "src-tauri/Cargo.toml"),
      "--test",
      "updater_http",
      "isolated_signed_installer_replaces_only_the_fixture",
      "--",
      "--ignored",
      "--nocapture",
    ],
    {
      cwd: root,
      stdio: "inherit",
      timeout: 180_000,
      env: {
        ...process.env,
        TEMP: directory,
        TMP: directory,
        CONTROL_ROOM_UPDATER_INSTALL_FIXTURE: fixture,
      },
    },
  );
} finally {
  cleanup();
}
