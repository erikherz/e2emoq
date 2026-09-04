#!/usr/bin/env node
// Print the PUBLIC half and kid of a JWK file, and say whether it matches what is deployed.
//
//   node scripts/moq-pubkey.mjs moqpro.jwk            # private or public half, either works
//   node scripts/moq-pubkey.mjs moqpro.jwk --expect <kid>
//
// Exists because a Cloudflare secret is write-only: once MOQ_PRO_JWK is set, the only way to
// answer "is the key I am about to register the one that is actually deployed?" is to compare
// the kid. Getting that wrong registers a key that verifies nothing, and the failure is silent
// — the CDN accepts the connection and drops it the moment it matters.
//
// `d` is never printed. Feed it a private JWK and only the public half comes back out.

import { webcrypto as c } from "node:crypto";
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: moq-pubkey.mjs <jwk file> [--expect <kid>]");
  process.exit(1);
}
const expectIdx = process.argv.indexOf("--expect");
const expect = expectIdx >= 0 ? process.argv[expectIdx + 1] : null;

let jwk;
try {
  jwk = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
  console.error(`could not read ${file}: ${e.message}`);
  process.exit(1);
}
if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
  console.error(`not an Ed25519 OKP JWK (kty=${jwk.kty} crv=${jwk.crv})`);
  process.exit(1);
}

// Recompute the thumbprint rather than trusting the file's own `kid` — a hand-edited or
// mismatched kid is exactly the failure this is meant to catch.
const b64url = (b) => Buffer.from(b).toString("base64url");
const thumbInput = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
const thumb = b64url(
  new Uint8Array(await c.subtle.digest("SHA-256", new TextEncoder().encode(thumbInput)))
);

const pub = { kty: "OKP", crv: "Ed25519", x: jwk.x, alg: "EdDSA", use: "sig", key_ops: ["verify"], kid: thumb };

console.log(`file      ${file}`);
console.log(`half      ${jwk.d ? "PRIVATE (d present — not printed)" : "public"}`);
console.log(`kid       ${thumb}`);
if (jwk.kid && jwk.kid !== thumb) {
  console.log(`          ⚠ the file's own kid is ${jwk.kid}, which is NOT the thumbprint above`);
}
console.log("\npublic JWK — paste this into moq.pro → Keys → Add Key → Import Asymmetric:\n");
console.log(JSON.stringify(pub, null, 2));

if (expect) {
  const ok = thumb === expect;
  console.log(`\n${ok ? "✓ MATCHES" : "✗ DOES NOT MATCH"} the expected kid ${expect}`);
  if (!ok) {
    console.log("  This is a different keypair from the one deployed. Registering it will not");
    console.log("  help — generate a fresh key instead and set the secret from it.");
  }
  process.exit(ok ? 0 : 1);
}
