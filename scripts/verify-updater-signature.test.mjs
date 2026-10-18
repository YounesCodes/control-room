import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("./verify-updater-signature.mjs", import.meta.url));
const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (
      dirname(directory) !== resolve(tmpdir()) ||
      !basename(directory).startsWith("control-room-signature-")
    )
      throw new Error("Refusing to remove a directory outside the signature fixtures");
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(algorithm = "ED", version = "1.0.0") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const id = Buffer.from("0102030405060708", "hex");
  const rawKey = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const contents = Buffer.from("a signed installer fixture");
  const message =
    algorithm === "ED" ? createHash("blake2b512").update(contents).digest() : contents;
  const signature = sign(null, message, privateKey);
  const comment = "timestamp:123456\tfile:installer.exe" + (version ? `\tversion:${version}` : "");
  const lines = [
    "untrusted comment: fixture",
    Buffer.concat([Buffer.from(algorithm), id, signature]).toString("base64"),
    `trusted comment: ${comment}`,
    sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey).toString("base64"),
  ];
  const key = Buffer.from(
    `untrusted comment: fixture\n${Buffer.concat([Buffer.from("Ed"), id, rawKey]).toString("base64")}\n`,
  ).toString("base64");
  return { contents, lines, key };
}

function run(input, signatureText = Buffer.from(input.lines.join("\n") + "\n").toString("base64")) {
  const directory = mkdtempSync(join(resolve(tmpdir()), "control-room-signature-"));
  directories.push(directory);
  mkdirSync(join(directory, "src-tauri"));
  writeFileSync(
    join(directory, "src-tauri/tauri.conf.json"),
    JSON.stringify({
      version: "1.0.0",
      plugins: { updater: { pubkey: input.key, requireSignedVersion: true } },
    }),
  );
  writeFileSync(join(directory, "installer.exe"), input.contents);
  writeFileSync(join(directory, "installer.exe.sig"), signatureText);
  return spawnSync(process.execPath, [script, "installer.exe", "installer.exe.sig"], {
    cwd: directory,
    encoding: "utf8",
    timeout: 10_000,
  });
}

describe("updater release signature verification", () => {
  it.each(["Ed", "ED"])("accepts a complete valid %s signature", (algorithm) => {
    expect(run(fixture(algorithm)).status).toBe(0);
  });
  it("rejects an altered trusted comment even when the installer signature is intact", () => {
    const input = fixture();
    input.lines[2] += " altered";
    expect(run(input).status).toBe(1);
  });
  it("rejects an altered global signature", () => {
    const input = fixture();
    const global = Buffer.from(input.lines[3], "base64");
    global[0] ^= 1;
    input.lines[3] = global.toString("base64");
    expect(run(input).status).toBe(1);
  });
  it("rejects an incomplete signature container", () => {
    const input = fixture();
    input.lines.length = 2;
    expect(run(input).status).toBe(1);
  });
  it("rejects altered installer bytes", () => {
    const input = fixture();
    input.contents[0] ^= 1;
    expect(run(input).status).toBe(1);
  });
  it("rejects invalid base64 instead of silently discarding invalid characters", () => {
    const input = fixture();
    const encoded = Buffer.from(input.lines.join("\n") + "\n").toString("base64");
    expect(run(input, "!" + encoded).status).toBe(1);
  });
  it("rejects a valid legacy signature with no signed version", () => {
    expect(run(fixture("ED", null)).status).toBe(1);
  });
  it("rejects a valid signature for a different version", () => {
    expect(run(fixture("ED", "0.9.0")).status).toBe(1);
  });
});
