import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

if (process.platform !== "win32") {
  console.error("Local lab tests require Windows for OpenSSH and ConPTY.");
  process.exit(1);
}

let configuration;
try {
  configuration = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
} catch {
  console.error("Create the ignored .env.local file described in docs/testing.md.");
  process.exit(1);
}

for (const line of configuration.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const match = /^(CONTROL_ROOM_TEST_(?:HOST|USER|PORT))=(.*)$/.exec(trimmed);
  if (!match) {
    console.error(".env.local accepts only CONTROL_ROOM_TEST_HOST, USER, and PORT.");
    process.exit(1);
  }
  process.env[match[1]] = match[2].trim();
}

const host = process.env.CONTROL_ROOM_TEST_HOST;
const user = process.env.CONTROL_ROOM_TEST_USER;
const port = process.env.CONTROL_ROOM_TEST_PORT || "22";
if (
  !host ||
  !user ||
  !/^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/.test(host) ||
  !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(user) ||
  !/^\d+$/.test(port) ||
  Number(port) < 1 ||
  Number(port) > 65535
) {
  console.error(".env.local needs a valid SSH host, user, and optional port.");
  process.exit(1);
}
process.env.CONTROL_ROOM_TEST_PORT = port;

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  if (result.error || result.status !== 0) {
    console.error(`${command} failed${result.error ? `: ${result.error.message}` : ""}.`);
    process.exit(1);
  }
}

const ssh = join(process.env.WINDIR || "C:\\Windows", "System32", "OpenSSH", "ssh.exe");
const npmCli =
  process.env.npm_execpath ||
  join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
console.log("Checking pinned-host, noninteractive SSH access to the local fixture.");
run(ssh, [
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "ConnectTimeout=10",
  "-p",
  port,
  "-l",
  user,
  host,
  "true",
]);

const tests = [
  "history::tests::live_history_install_is_reversible_in_an_isolated_home",
  "remote::tests::live_ubuntu_structured_reads_return_typed_evidence",
  "remote::tests::live_ubuntu_baseline_capture_is_ephemeral_and_typed",
  "session::tests::conpty_hosts_windows_ssh_against_live_fixture",
];
for (const test of tests) {
  console.log(`Running ${test}`);
  run("cargo", [
    "test",
    "--locked",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    test,
    "--",
    "--ignored",
    "--exact",
  ]);
}

console.log("Building the isolated desktop E2E app.");
run(process.execPath, [npmCli, "run", "test:desktop:build"]);
console.log("Testing the real SSH connection through the desktop UI.");
run(process.execPath, [npmCli, "run", "test:desktop"], { CONTROL_ROOM_LIVE_DESKTOP: "1" });
