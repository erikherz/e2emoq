#!/usr/bin/env node
// moqplay BYOK signing keypair — generate if absent, store the PRIVATE half, print the PUBLIC.
//
//   npm run keygen                                        # Cloudflare: store private as the
//                                                         #   MOQ_AUTH_PRIVATE_JWK secret
//   npm run keygen -- --out-env /etc/moqplay/moqplay.env  # self-host: write into an env file
//   npm run keygen -- --force                             # rotate even if a key already exists
//
//   npm run keygen -- --secret MOQ_PRO_JWK --out-file moqpro.jwk
//                                                         # moq.pro: write the private half to
//                                                         #   a file so the PUBLIC half can be
//                                                         #   registered BEFORE the secret exists
//
// ORDER MATTERS FOR moq.pro. The instant MOQ_PRO_JWK exists, every broadcast routes to
// cdn.moq.pro — so if the public half is not registered there yet, they all fail. Use
// --out-file, register the printed public JWK under Keys -> Add Key, and only then pipe the
// file into `wrangler secret put`. --out-file exists for exactly that gap.
//
// Idempotent: if a key is already present it does nothing (unless --force). The PRIVATE half
// is NEVER printed or transmitted — only written to the secret store / env file. The PUBLIC
// verify JWK is printed to stdout as plain JSON for the operator to paste as verify_jwk.
//
// Diagnostics go to stderr; stdout carries ONLY the public JWK, so it's safe to pipe/capture.

import { webcrypto as c } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";

const args = process.argv.slice(2);
const force = args.includes("--force");
const envFileIdx = args.indexOf("--out-env");
const envFile = envFileIdx >= 0 ? args[envFileIdx + 1] : null;
const outFileIdx = args.indexOf("--out-file");
const outFile = outFileIdx >= 0 ? args[outFileIdx + 1] : null;
// Which secret this key is for. MOQ_AUTH_PRIVATE_JWK signs tokens for our OWN relay fleet;
// MOQ_PRO_JWK signs tokens for moq.pro. Same algorithm, different verifier — and they must
// never be the same key, or a compromise of one deployment forges tokens for the other.
const secretIdx = args.indexOf("--secret");
const SECRET = secretIdx >= 0 ? args[secretIdx + 1] : "MOQ_AUTH_PRIVATE_JWK";

const log = (...m) => console.error(...m); // stderr — keep stdout clean for the public JWK
const b64url = (b) => Buffer.from(b).toString("base64url");

function privateKeyPresent() {
  if (envFile) {
    return existsSync(envFile) && new RegExp(`^\\s*${SECRET}\\s*=`, "m").test(readFileSync(envFile, "utf8"));
  }
  try {
    const out = execFileSync("npx", ["wrangler", "secret", "list"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(out).some((s) => s.name === SECRET);
  } catch {
    return false; // can't tell (e.g. Worker not deployed yet) — treat as absent
  }
}

function writeEnv(file, name, value) {
  let body = existsSync(file) ? readFileSync(file, "utf8") : "";
  const line = `${name}=${value}`;
  const re = new RegExp(`^\\s*${name}\\s*=.*$`, "m");
  body = re.test(body) ? body.replace(re, line) : body + (body && !body.endsWith("\n") ? "\n" : "") + line + "\n";
  writeFileSync(file, body);
  try { chmodSync(file, 0o600); } catch { /* best effort */ }
}

if (!outFile && privateKeyPresent() && !force) {
  log(`✓ ${SECRET} already set — nothing to do.`);
  log(`  Print the public verify JWK anytime from the running Worker at /api/pubkey,`);
  log(`  or re-run with --force to ROTATE the key (you must re-register the new public key).`);
  process.exit(0);
}

// --- generate a fresh Ed25519 keypair ---
const { publicKey, privateKey } = await c.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const pub = await c.subtle.exportKey("jwk", publicKey);
const priv = await c.subtle.exportKey("jwk", privateKey);

// RFC 7638 JWK thumbprint — the kid the relay selects the verify key by.
const thumb = JSON.stringify({ crv: pub.crv, kty: pub.kty, x: pub.x });
const kid = b64url(new Uint8Array(await c.subtle.digest("SHA-256", new TextEncoder().encode(thumb))));
pub.kid = kid;
priv.kid = kid;

// RFC 8037 §3.1: the JWA algorithm name for Ed25519 signatures is "EdDSA". Node's exportKey
// stamps `alg: "Ed25519"` instead, and workerd REJECTS that on import — the Worker throws
// DataError and every go-live returns a Cloudflare 500 with no usable message. The public
// half below is built by hand and was always correct; the private half was shipped raw, so
// the two halves disagreed and the Worker refused its own key. Fix it at rest, here, as well
// as at import time in src/worker/auth/moq-token.ts.
priv.alg = "EdDSA";

const privateJwk = JSON.stringify(priv); // contains `d` — never printed
const publicJwk = { kty: "OKP", crv: "Ed25519", x: pub.x, alg: "EdDSA", use: "sig", key_ops: ["verify"], kid };

// --- store the PRIVATE half (never to stdout) ---
if (outFile) {
  // The private half, alone, in a file the operator pipes in later. 0600 immediately: this
  // value is equivalent to the ability to mint publish tokens for the whole account.
  writeFileSync(outFile, privateJwk);
  try { chmodSync(outFile, 0o600); } catch { /* best effort */ }
  log(`✓ wrote the PRIVATE ${SECRET} to ${outFile} (chmod 600) — not set as a secret yet`);
  // Keep the PUBLIC half on disk. It is public by definition, and without it there is no way
  // to answer "which key is deployed?" once the private half is a write-only Cloudflare secret
  // — which is how an unregistered key went unnoticed until every broadcast failed. The kid is
  // the value moq.pro lists, so this file is what a future check compares against.
  const pubFile = `${outFile}.pub.json`;
  writeFileSync(pubFile, JSON.stringify(publicJwk, null, 2) + "\n");
  log(`✓ wrote the PUBLIC half to ${pubFile} — safe to keep, and to commit`);
  log("");
  log(`  ⚠ REGISTER THE PUBLIC KEY AT moq.pro FIRST — Keys → Add Key → Import Asymmetric.`);
  log(`    Nothing works until a key with kid ${kid} is listed there.`);
  log(`    Then, and only then:`);
  log(`      cat ${outFile} | npx wrangler secret put ${SECRET}`);
  log(`      rm ${outFile}`);
} else if (envFile) {
  writeEnv(envFile, SECRET, privateJwk);
  log(`✓ wrote ${SECRET} to ${envFile} (chmod 600)`);
} else {
  const r = spawnSync("npx", ["wrangler", "secret", "put", SECRET], {
    input: privateJwk,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (r.status !== 0) {
    log(`✗ could not set the ${SECRET} secret via wrangler.`);
    log(`  Make sure the Worker is deployed and you're logged in (npx wrangler login), then re-run.`);
    process.exit(1);
  }
  log(`✓ set ${SECRET} as a Cloudflare secret`);
}

// --- print ONLY the public verify JWK (stdout, plain JSON) ---
log("\nPublic verify JWK — paste into your CDN console / relay verify_jwk:\n");
console.log(JSON.stringify(publicJwk, null, 2));
log(`\nkid: ${kid}`);
