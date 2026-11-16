import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const CHECKSUMS = "SHA256SUMS.txt";
export const FEED = "latest.json";

const PACKAGES = [
  { label: "Windows installer", pattern: /-setup\.exe$/, count: () => 1 },
  { label: "AppImage", pattern: /\.AppImage$/, count: () => 1 },
  { label: "Debian package", pattern: /_amd64\.deb$/, count: () => 1 },
  { label: "macOS disk image", pattern: /\.dmg$/, count: (macos) => (macos ? 2 : 0) },
  {
    label: "macOS updater archive",
    pattern: /\.app\.tar\.gz$/,
    count: (macos) => (macos ? 2 : 0),
  },
];

export function releasePackages(names, { includeMacos }) {
  const forbidden = names.filter((name) => /\.(sig|sha256)$/.test(name));
  assert.deepEqual(forbidden, [], "Signature or per-package checksum assets are still published");
  assert.ok(names.includes(FEED), "The release has no " + FEED);

  const packages = [];
  for (const { label, pattern, count } of PACKAGES) {
    const matches = names.filter((name) => pattern.test(name));
    assert.equal(
      matches.length,
      count(includeMacos),
      "Expected " + count(includeMacos) + " " + label + " asset(s), found: " + matches.join(", "),
    );
    packages.push(...matches);
  }
  const unexpected = names.filter(
    (name) => name !== FEED && name !== CHECKSUMS && !packages.includes(name),
  );
  assert.deepEqual(unexpected, [], "Unexpected release assets");
  return packages.sort();
}

export function requiredFeedPlatforms({ includeMacos }) {
  const platforms = [
    "windows-x86_64",
    "windows-x86_64-nsis",
    "linux-x86_64",
    "linux-x86_64-appimage",
  ];
  if (includeMacos) platforms.push("darwin-aarch64", "darwin-x86_64");
  return platforms;
}

export function feedSignatures(feed, assets, required) {
  const platforms = feed?.platforms ?? {};
  for (const key of required)
    assert.ok(platforms[key], "The updater feed has no " + key + " entry");
  return Object.entries(platforms).map(([platform, entry]) => {
    const asset = assets.find(({ apiUrl }) => apiUrl === entry?.url);
    assert.ok(asset, platform + " must point to an uploaded release asset");
    assert.ok(
      typeof entry.signature === "string" && entry.signature.trim(),
      platform + " has no signature in the updater feed",
    );
    return { platform, name: asset.name, signature: entry.signature.trim() };
  });
}

export function formatChecksums(hashes) {
  return (
    [...hashes.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, hash]) => hash + "  " + name)
      .join("\n") + "\n"
  );
}

export function verifyChecksums(text, hashes) {
  const listed = new Map();
  for (const line of text.replaceAll("\r\n", "\n").split("\n")) {
    if (!line) continue;
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    assert.ok(match, CHECKSUMS + " has a malformed line: " + JSON.stringify(line));
    assert.ok(!listed.has(match[2]), CHECKSUMS + " lists " + match[2] + " twice");
    listed.set(match[2], match[1]);
  }
  for (const [name, hash] of hashes) {
    assert.ok(listed.has(name), CHECKSUMS + " has no entry for " + name);
    assert.equal(listed.get(name), hash, CHECKSUMS + " has the wrong hash for " + name);
  }
  const extra = [...listed.keys()].filter((name) => !hashes.has(name));
  assert.deepEqual(extra, [], CHECKSUMS + " lists files that are not release packages");
}

function main() {
  const tag = process.env.GITHUB_REF_NAME;
  assert.match(tag ?? "", /^v\d+\.\d+\.\d+$/);
  const includeMacos = process.env.INCLUDE_MACOS === "true";
  const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" });
  const download = (name, dir) => {
    gh("release", "download", tag, "--pattern", name, "--dir", dir, "--clobber");
    return join(dir, name);
  };

  const { assets } = JSON.parse(gh("release", "view", tag, "--json", "assets"));
  const packages = releasePackages(
    assets.map(({ name }) => name),
    { includeMacos },
  );

  const feed = JSON.parse(readFileSync(download(FEED, "."), "utf8"));
  assert.equal(feed.version, tag.slice(1), "Updater feed version differs from the tag");

  const work = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "release-assets-"));
  const hashes = new Map();
  for (const name of packages) {
    const contents = readFileSync(download(name, work));
    hashes.set(name, createHash("sha256").update(contents).digest("hex"));
  }

  for (const { platform, name, signature } of feedSignatures(
    feed,
    assets,
    requiredFeedPlatforms({ includeMacos }),
  )) {
    console.log("Checking the " + platform + " signature for " + name);
    const signaturePath = join(work, platform + ".sig");
    writeFileSync(signaturePath, signature);
    execFileSync(
      process.execPath,
      ["scripts/verify-updater-signature.mjs", join(work, name), signaturePath],
      { stdio: "inherit" },
    );
  }

  const checksums = join(work, CHECKSUMS);
  writeFileSync(checksums, formatChecksums(hashes));
  gh("release", "upload", tag, checksums, "--clobber");
  const published = mkdtempSync(join(work, "published-"));
  verifyChecksums(readFileSync(download(CHECKSUMS, published), "utf8"), hashes);

  const final = JSON.parse(gh("release", "view", tag, "--json", "assets")).assets;
  assert.ok(
    final.some(({ name }) => name === CHECKSUMS),
    CHECKSUMS + " was not published",
  );
  releasePackages(
    final.map(({ name }) => name),
    { includeMacos },
  );
  console.log("OK    " + packages.length + " packages, " + CHECKSUMS + ", and " + FEED);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
