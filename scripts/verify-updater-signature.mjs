// Verifies a Tauri updater signature against the public key committed in
// src-tauri/tauri.conf.json.
//
// This answers the one question a release cannot answer in time: whether the
// private key held in CI is actually the pair of the public key built into the
// application. A mismatch produces a release that publishes perfectly and is
// then rejected by every installed copy, which is only discoverable after the
// damage is done. Checking it here costs a second.
//
// Only public material is read. The private key is never touched.
//
//   node scripts/verify-updater-signature.mjs <signed-file> <signature-file>

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

/** Minisign keys and signatures are base64 of a small text file. */
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

// The decisive check. Key ids are derived from the pair, so a signature made by
// a different private key carries a different id and is caught here with a far
// clearer message than a generic verification failure.
if (!publicKeyId.equals(signatureKeyId)) {
  fail(
    `signature was made by a different key\n` +
      `      public key id: ${publicKeyId.toString("hex")}\n` +
      `      signature key id: ${signatureKeyId.toString("hex")}\n` +
      `      The private key in use is not the pair of the committed public key.`,
  );
}

// "ED" is minisign's prehashed variant, which is what the Tauri signer emits:
// the Ed25519 signature covers BLAKE2b-512 of the file, not the file itself.
// "Ed" is the legacy variant that signs the bytes directly.
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

// Match the updater's Minisign verifier: the second signature authenticates
// the payload signature together with the exact trusted comment bytes.
const globalMessage = Buffer.concat([
  rawSignature,
  Buffer.from(signatureLines[2].slice("trusted comment: ".length), "utf8"),
]);
if (!verify(null, globalMessage, publicKey, globalSignature)) {
  fail("the trusted comment or global signature does not verify against the committed public key");
}

console.log("OK    signature verifies against the public key in src-tauri/tauri.conf.json");
console.log(`      key id ${publicKeyId.toString("hex")}, algorithm ${algorithm}`);
