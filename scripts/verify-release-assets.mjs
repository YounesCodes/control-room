import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const tag = process.env.GITHUB_REF_NAME;
assert.match(tag ?? "", /^v\d+\.\d+\.\d+$/);

function gh(...args) {
  return execFileSync("gh", args, { encoding: "utf8" });
}

const { assets } = JSON.parse(gh("release", "view", tag, "--json", "assets"));
function asset(pattern) {
  const matches = assets.filter(({ name }) => pattern.test(name));
  assert.equal(matches.length, 1, "Expected one release asset matching " + pattern);
  return matches[0];
}

function download({ name }) {
  gh("release", "download", tag, "--pattern", name, "--clobber");
  return readFileSync(name);
}

const feed = JSON.parse(download(asset(/^latest\.json$/)));
assert.equal(feed.version, tag.slice(1), "Updater feed version differs from the tag");

const windows = asset(/-setup\.exe$/);
const appimage = asset(/\.AppImage$/);
const deb = asset(/_amd64\.deb$/);
const windowsChecksum = asset(/-setup\.exe\.sha256$/);

for (const [platform, format, bundle, signature] of [
  ["windows-x86_64", "nsis", windows, asset(/-setup\.exe\.sig$/)],
  ["linux-x86_64", "appimage", appimage, asset(/\.AppImage\.sig$/)],
]) {
  const contents = download(signature).toString("utf8").trim();
  for (const key of [platform, platform + "-" + format]) {
    const entry = feed.platforms[key];
    assert.equal(entry?.url, bundle.apiUrl, key + " must point to the uploaded bundle");
    assert.equal(entry.signature.trim(), contents, key + " has the wrong signature");
  }
  download(bundle);
  execFileSync(
    process.execPath,
    ["scripts/verify-updater-signature.mjs", bundle.name, signature.name],
    { stdio: "inherit" },
  );
}

function checksum(bundle) {
  const hash = createHash("sha256").update(readFileSync(bundle.name)).digest("hex");
  return hash + "  " + bundle.name + "\n";
}

assert.equal(
  download(windowsChecksum).toString("utf8").replaceAll("\r\n", "\n"),
  checksum(windows),
);
download(deb);
for (const bundle of [appimage, deb]) {
  const path = bundle.name + ".sha256";
  writeFileSync(path, checksum(bundle));
  gh("release", "upload", tag, path, "--clobber");
}
