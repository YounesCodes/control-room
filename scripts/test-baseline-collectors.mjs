import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = readFileSync(
  new URL("../src-tauri/src/baseline_collectors.rs", import.meta.url),
  "utf8",
);
const remote = readFileSync(new URL("../src-tauri/src/remote.rs", import.meta.url), "utf8");
const temporary = mkdtempSync(join(tmpdir(), "control-room-collectors-"));
const unix = (path) =>
  path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => "/" + drive.toLowerCase());
const base = unix(temporary);
const shell = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/sh";
const bin = join(temporary, "bin");
mkdirSync(bin);
const quote = (text) => "'" + text.replaceAll("'", "'\"'\"'") + "'";
function mock(name, body) {
  writeFileSync(join(bin, name), "#!/bin/sh\n" + body + "\n", { mode: 0o755 });
}
function script(name) {
  const match = source.match(new RegExp("(?:pub )?const " + name + ': &str = r#"([\\s\\S]*?)"#;'));
  assert.ok(match, name + " exists");
  return match[1];
}
function run(text, expectedStatus = 0) {
  const result = spawnSync(
    shell,
    ["-c", "PATH=" + quote(unix(bin) + ":/usr/bin:/bin") + "; export PATH;\n" + text],
    { encoding: "utf8", timeout: 60000 },
  );
  assert.equal(result.status, expectedStatus, result.stderr || result.error?.message);
  return result.stdout;
}
try {
  mock(
    "sshd",
    "printf 'permitrootlogin no\\npasswordauthentication no\\nauthorizedkeyscommand SECRET_VALUE\\n'",
  );
  mock(
    "getent",
    "case \"$1:$2\" in group:sudo) printf 'sudo:x:27:alice\\n';; group:*) exit 2;; passwd:) printf 'root:x:0:0:SECRET_VALUE:/root:/bin/sh\\nalice:x:1000:27:person:/home/alice:/bin/sh\\n';; esac",
  );
  mock("cat", 'case "$1" in /proc/sys/*) printf \'1\\n\';; *) /bin/cat "$@";; esac');
  let output = run(
    script("CONFIGURATION").replaceAll("/etc/docker/daemon.json", base + "/missing-daemon"),
  );
  assert.match(output, /sshd\tpermitrootlogin\tno/);
  assert.match(output, /group\/sudo\tmembers\talice/);
  assert.doesNotMatch(output, /SECRET_VALUE|authorizedkeyscommand/);

  mock(
    "systemctl",
    "printf 'Id=backup.timer\\nFragmentPath=/etc/systemd/system/backup.timer\\nTimersCalendar={ OnCalendar=daily ; next_elapse=999999 }\\nTriggers=backup.service\\n\\n'",
  );
  output = run(script("SYSTEMD"));
  assert.match(output, /backup.timer\tTimersCalendar\t.*daily/);
  assert.doesNotMatch(output, /999999/);

  writeFileSync(
    join(temporary, "fstab"),
    "UUID=abcd / ext4 defaults,nosuid,password=SECRET_VALUE 0 1\n//alice:SECRET_VALUE@host/share /data cifs credentials=/private 0 0\n",
  );
  mock("findmnt", "printf '/ /dev/sda1\\n'");
  output = run(script("STORAGE").replaceAll("/etc/fstab", base + "/fstab"));
  assert.match(output, /fstab\/.*\toptions\tdefaults,nosuid/);
  assert.match(output, /source redacted/);
  assert.doesNotMatch(output, /SECRET_VALUE|credentials|private/);

  mock(
    "ip",
    "case \"$*\" in '-o link show') printf '2: eth0: <UP> mtu 1500 link/ether 00:11:22:33:44:55\\n';; '-4 route show default') printf 'default via 192.0.2.1 dev eth0 metric 100\\n';; esac",
  );
  output = run(script("NETWORK"));
  assert.match(output, /interface\/eth0\tmtu\t1500/);
  assert.match(output, /gateway\t192.0.2.1/);

  mock(
    "ufw",
    "printf 'Status: active\\nDefault: deny (incoming)\\n22/tcp ALLOW IN Anywhere # SECRET_VALUE\\n'",
  );
  output = run(script("FIREWALL"));
  assert.match(output, /rule\/0003\trule\t22\/tcp ALLOW IN Anywhere/);
  assert.match(output, /Default: deny/);
  assert.doesNotMatch(output, /SECRET_VALUE/);

  writeFileSync(
    join(temporary, "dpkg.log"),
    "2026-11-01 10:00:00 upgrade demo:amd64 1.0 2.0\n2026-11-01 11:00:00 arbitrary SECRET_VALUE\n",
  );
  output = run(script("PACKAGE_HISTORY").replaceAll("/var/log/dpkg.log", base + "/dpkg.log"));
  assert.match(output, /previousVersion\t1.0/);
  assert.match(output, /version\t2.0/);
  assert.doesNotMatch(output, /SECRET_VALUE/);

  mock(
    "dpkg-query",
    "printf 'installed\\tdemo\\tamd64\\t2.0\\nconfig-files\\tremoved-demo\\tamd64\\t1.0\\n'",
  );
  output = run(script("PACKAGES"));
  assert.match(output, /demo\tamd64\t2.0/);
  assert.doesNotMatch(output, /removed-demo/);
  mock("dpkg-query", "exit 7");
  run(script("PACKAGES"), 7);

  const cronMatch = remote.match(/pub fn list_cron_jobs[\s\S]*?let command = r#"([\s\S]*?)"#;/);
  assert.ok(cronMatch);
  mkdirSync(join(temporary, "cron.d"));
  const cron = cronMatch[1]
    .replaceAll("/etc/crontab", base + "/crontab")
    .replaceAll("/etc/cron.d", base + "/cron.d")
    .replaceAll("/var/spool/cron", base + "/spool");
  const captureCron = (command) => {
    writeFileSync(
      join(temporary, "crontab"),
      "@reboot root " + command + "\n0 2 * * * root /bin/backup --secret=SECRET_VALUE\n",
    );
    return run(cron);
  };
  const first = captureCron("TOKEN=SECRET_VALUE /bin/job --mode=one");
  const second = captureCron("TOKEN=SECRET_VALUE /bin/job --mode=two");
  assert.match(first, /@reboot/);
  assert.doesNotMatch(first, /SECRET_VALUE|TOKEN|\/bin\/job|backup/);
  assert.notEqual(first, second, "same-length command edits change the fingerprint");
  assert.match(first, /redacted\t\d+\t[a-f0-9]{64}/);
  assert.match(first, /__CR_CRON_DONE__/);

  console.log(
    "Collector shell fixtures passed: configuration privacy, timers, mounts, routes, firewall order, package history, cron hashing.",
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
