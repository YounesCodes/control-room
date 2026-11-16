import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";

const [, , signedPath, signaturePath] = process.argv;
if (!signedPath || !signaturePath) {
  console.error("usage: verify-updater-signature.mjs <signed-file> <signature-file>");
  process.exit(2);
}

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}

function decodeBase64(text, label) {
  if (typeof text !== "string" || !text.length) fail(`${label} is empty`);
  const bytes = Buffer.from(text, "base64");
  // Buffer.from silently skips invalid characters and accepts truncated input.
  if (bytes.toString("base64") !== text) {
    fail(`${label} is not valid base64`);
  }
  return bytes;
}

function decodeContainer(base64Text, label) {
  if (typeof base64Text !== "string") fail(`${label} is not text`);
  const bytes = decodeBase64(base64Text.trim(), label);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) fail(`${label} is not valid UTF-8`);
  return text.split(/\r?\n/);
}

const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const configuredKey = config?.plugins?.updater?.pubkey;
if (!configuredKey) fail("plugins.updater.pubkey is empty in src-tauri/tauri.conf.json");

// Public key: 2-byte algorithm, 8-byte key id, 32-byte Ed25519 key.
const publicKeyLines = decodeContainer(configuredKey, "public key");
const publicKeyBlob = decodeBase64(publicKeyLines[1], "public key payload");
if (publicKeyBlob.length !== 42) fail(`public key is ${publicKeyBlob.length} bytes, expected 42`);
if (!["Ed", "ED"].includes(publicKeyBlob.subarray(0, 2).toString("latin1")))
  fail("unsupported public key algorithm");
const publicKeyId = publicKeyBlob.subarray(2, 10);
const rawPublicKey = publicKeyBlob.subarray(10);

// Signature: 2-byte algorithm, 8-byte key id, 64-byte signature.
const signatureLines = decodeContainer(readFileSync(signaturePath, "utf8"), "signature");
if (signatureLines.length < 4 || !signatureLines[2].startsWith("trusted comment: "))
  fail("signature has no trusted comment or global signature");
const signatureBlob = decodeBase64(signatureLines[1], "signature payload");
if (signatureBlob.length !== 74) fail(`signature is ${signatureBlob.length} bytes, expected 74`);
const globalSignature = decodeBase64(signatureLines[3], "global signature");
if (globalSignature.length !== 64)
  fail(`global signature is ${globalSignature.length} bytes, expected 64`);
const algorithm = signatureBlob.subarray(0, 2).toString("latin1");
const signatureKeyId = signatureBlob.subarray(2, 10);
const rawSignature = signatureBlob.subarray(10);

if (!publicKeyId.equals(signatureKeyId)) {
  fail(
    `signature was made by a different key\n` +
      `      public key id: ${publicKeyId.toString("hex")}\n` +
      `      signature key id: ${signatureKeyId.toString("hex")}\n` +
      `      The private key in use is not the pair of the committed public key.`,
  );
}

// Tauri signs with minisign's prehashed ED variant: Ed25519 over BLAKE2b-512 of the file.
const contents = readFileSync(signedPath);
let message;
if (algorithm === "ED") {
  message = createHash("blake2b512").update(contents).digest();
} else if (algorithm === "Ed") {
  message = contents;
} else {
  fail(`unknown signature algorithm ${JSON.stringify(algorithm)}`);
}

// Node needs a DER SPKI wrapper around the raw 32-byte key.
const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawPublicKey]);
const publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });

if (!verify(null, message, publicKey, rawSignature)) {
  fail("the signature does not verify against the committed public key");
}

// Minisign's global signature covers the payload signature plus the trusted comment bytes.
const globalMessage = Buffer.concat([
  rawSignature,
  Buffer.from(signatureLines[2].slice("trusted comment: ".length), "utf8"),
]);
if (!verify(null, globalMessage, publicKey, globalSignature)) {
  fail("the trusted comment or global signature does not verify against the committed public key");
}

const signedVersion = signatureLines[2]
  .slice("trusted comment: ".length)
  .split("\t")
  .find((field) => field.startsWith("version:"))
  ?.slice("version:".length);
if (config.plugins.updater.requireSignedVersion && !signedVersion) {
  fail("the signature does not bind the installer to a version");
}
if (signedVersion && signedVersion.replace(/^v/, "") !== config.version?.replace(/^v/, "")) {
  fail("the signed installer version does not match src-tauri/tauri.conf.json");
}

console.log("OK    signature verifies against the public key in src-tauri/tauri.conf.json");
console.log(`      key id ${publicKeyId.toString("hex")}, algorithm ${algorithm}`);
