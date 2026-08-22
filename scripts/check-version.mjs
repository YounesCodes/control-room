import { readFileSync } from "node:fs";

const packageVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url)),
).version;
const tauriVersion = JSON.parse(
  readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url)),
).version;
const cargoManifest = readFileSync(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8");
const cargoVersion = cargoManifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];

const versions = new Map([
  ["package.json", packageVersion],
  ["src-tauri/tauri.conf.json", tauriVersion],
  ["src-tauri/Cargo.toml", cargoVersion],
]);
const unique = new Set(versions.values());
if (unique.size !== 1 || unique.has(undefined)) {
  for (const [file, version] of versions) console.error(`${file}: ${version ?? "missing"}`);
  process.exitCode = 1;
} else if (process.env.GITHUB_REF_TYPE === "tag") {
  const tagVersion = process.env.GITHUB_REF_NAME?.replace(/^v/, "");
  if (tagVersion !== packageVersion) {
    console.error(`Tag ${process.env.GITHUB_REF_NAME} does not match version ${packageVersion}`);
    process.exitCode = 1;
  }
}
