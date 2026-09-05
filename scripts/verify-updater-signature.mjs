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

/** Minisign keys and signatures are base64 of a small text file. */
function decodeContainer(base64Text, label) {
  let text;
  try {
    text = Buffer.from(base64Text.trim(), "base64").toString("utf8");
  } catch {
    fail(`${label} is not valid base64`);
  }
  // Line 1 is an untrusted comment; line 2 is the payload.
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const payload = lines.find((line) => !line.toLowerCase().startsWith("untrusted comment:"));
  if (!payload) fail(`${label} has no payload line`);
  return Buffer.from(payload.trim(), "base64");
}

const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const configuredKey = config?.plugins?.updater?.pubkey;
if (!configuredKey) fail("plugins.updater.pubkey is empty in src-tauri/tauri.conf.json");

// Public key: 2-byte algorithm, 8-byte key id, 32-byte Ed25519 key.
const publicKeyBlob = decodeContainer(configuredKey, "public key");
if (publicKeyBlob.length !== 42) fail(`public key is ${publicKeyBlob.length} bytes, expected 42`);
const publicKeyId = publicKeyBlob.subarray(2, 10);
const rawPublicKey = publicKeyBlob.subarray(10);

// Signature: 2-byte algorithm, 8-byte key id, 64-byte signature.
const signatureBlob = decodeContainer(readFileSync(signaturePath, "utf8"), "signature");
if (signatureBlob.length !== 74) fail(`signature is ${signatureBlob.length} bytes, expected 74`);
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

console.log("OK    signature verifies against the public key in src-tauri/tauri.conf.json");
console.log(`      key id ${publicKeyId.toString("hex")}, algorithm ${algorithm}`);
