import { spawnSync } from "node:child_process";
import { join } from "node:path";

if (process.platform !== "win32") {
  console.error("Live SSH tests require Windows for the ConPTY fixture test.");
  process.exit(1);
}

const host = process.env.CONTROL_ROOM_TEST_HOST?.trim();
const user = process.env.CONTROL_ROOM_TEST_USER?.trim();
const portText = process.env.CONTROL_ROOM_TEST_PORT?.trim() || "22";
const port = Number(portText);

if (!host || !user || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(
    "Set CONTROL_ROOM_TEST_HOST, CONTROL_ROOM_TEST_USER, and optional CONTROL_ROOM_TEST_PORT (1-65535).",
  );
  process.exit(1);
}

const ssh = join(process.env.WINDIR || "C:\\Windows", "System32", "OpenSSH", "ssh.exe");
const preflight = spawnSync(
  ssh,
  [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=10",
    "-p",
    portText,
    `${user}@${host}`,
    "true",
  ],
  { stdio: "inherit", timeout: 20_000 },
);
if (preflight.error || preflight.status !== 0) {
  console.error(
    "SSH preflight failed. Check the configured key, known_hosts, host, user, and port.",
  );
  process.exit(1);
}

const tests = [
  "history::tests::live_history_install_is_reversible_in_an_isolated_home",
  "remote::tests::live_fixture_supports_structured_features",
  "session::tests::conpty_hosts_windows_ssh_against_live_fixture",
];
const listed = spawnSync(
  "cargo",
  ["test", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--", "--ignored", "--list"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);
if (
  listed.error ||
  listed.status !== 0 ||
  tests.some((test) => !listed.stdout.includes(`${test}: test`))
) {
  console.error("The expected ignored Rust fixture tests were not found.");
  process.exit(1);
}

for (const test of tests) {
  const run = spawnSync(
    "cargo",
    [
      "test",
      "--locked",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      test,
      "--",
      "--ignored",
      "--exact",
    ],
    { stdio: "inherit" },
  );
  if (run.error || run.status !== 0) {
    console.error(`Live fixture test failed: ${test}`);
    process.exit(1);
  }
}
