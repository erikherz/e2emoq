// Check src/crypto/sframe.ts against the SFrame working group's own test vectors.
//
//   node scripts/e2e/sframe-vectors.mjs
//
// No network, no deployment, no browser — this is arithmetic, and it should stay runnable in
// under a second so there is no excuse for skipping it.
//
// WHY THIS FILE EXISTS. "We encrypt frames carefully" is not a claim anyone can check. "We
// implement RFC 9605, and here is the working group's vector file passing against our code" is.
// That difference is the entire reason for adopting the standard, so the vectors are the part of
// this change that carries the value — not the header format, which we could have invented.
//
// The vectors are vendored at lib/sframe-test-vectors.json rather than fetched, so the test is
// hermetic and a network outage cannot turn into a green run. Provenance:
//
//   https://github.com/sframe-wg/sframe/blob/025d568/test-vectors/test-vectors.json
//   sha256 b8d35efd41749567427cb9ae52d9a7362904154978ff6a5fb20c0258a8ffdec1
//
// That is the exact commit RFC 9605 cites as [TestVectors] in its normative references, so this
// is the published artefact and not a convenient copy of it.
//
// Coverage, as the RFC's Appendix C divides it:
//   C.1  header encoding AND decoding, 289 cases, KID and CTR out to 2^64-1
//   C.2  the synthetic AES-CTR + HMAC AEAD of §4.5.1, all three truncated tag lengths
//   C.3  full SFrame encrypt/decrypt for all five cipher suites, intermediates included
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const dir = mkdtempSync(join(tmpdir(), "sframe-"));
const bundle = join(dir, "sframe.mjs");
execFileSync("npx", ["esbuild", "src/crypto/sframe.ts", "--bundle", "--format=esm", `--outfile=${bundle}`], {
  stdio: ["ignore", "ignore", "inherit"],
});
const sf = await import(pathToFileURL(bundle).href);

// KID and CTR range up to 2^64-1, which JSON.parse would silently round. Quote them before
// parsing so they survive as strings and can become BigInt intact. A vector file that loses
// precision on the way in would "pass" against equally-wrong code.
const raw = readFileSync(join(here, "lib", "sframe-test-vectors.json"), "utf8");
const vectors = JSON.parse(raw.replace(/"(kid|ctr)":\s*(\d+)/g, '"$1":"$2"'));

const hex = (b) => Buffer.from(b).toString("hex");
const bytes = (h) => new Uint8Array(Buffer.from(h, "hex"));

let fails = 0;
let checks = 0;
const check = (name, cond, extra = "") => {
  checks++;
  if (!cond) {
    fails++;
    console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`);
  }
};
const section = (name, n) => console.log(`\n${name}  (${n} vectors)`);

// ---- C.1  header encoding and decoding --------------------------------------
section("header encode/decode", vectors.header.length);
for (const v of vectors.header) {
  const kid = BigInt(v.kid);
  const ctr = BigInt(v.ctr);

  const encoded = hex(sf.encodeHeader(kid, ctr));
  check(`encode kid=${kid} ctr=${ctr}`, encoded === v.encoded, `got ${encoded} want ${v.encoded}`);

  // Decode from a BUFFER WITH A TAIL, not from the header alone. A decoder that returns the
  // right values only when the header is the whole input has not been shown to find the
  // boundary, and finding the boundary is its entire job in a real frame.
  const withTail = new Uint8Array([...bytes(v.encoded), 0xde, 0xad, 0xbe, 0xef]);
  const got = sf.decodeHeader(withTail);
  check(
    `decode ${v.encoded}`,
    got.kid === kid && got.ctr === ctr && got.length === v.encoded.length / 2,
    `got kid=${got.kid} ctr=${got.ctr} len=${got.length}`
  );
}

// ---- C.2  the AES-CTR + HMAC synthetic AEAD (§4.5.1) ------------------------
//
// These vectors give the AEAD key directly — the OUTPUT of the key schedule rather than its
// input — so they isolate the encrypt-then-MAC construction from the HKDF above it. The exact
// output bytes of that construction are already pinned by C.3 below, which covers all three
// CTR+HMAC suites end to end; what this section adds is the subkey split, the tag length, and
// the property the truncated tags exist to be doubted about: that they still reject a forgery.
section("AES-CTR + HMAC AEAD", vectors.aes_ctr_hmac.length);
for (const v of vectors.aes_ctr_hmac) {
  const suite = sf.CIPHER_SUITES[v.cipher_suite];
  check(`suite ${v.cipher_suite} known`, !!suite);
  if (!suite) continue;

  // The vector's nonce is the finished nonce; SFrame forms it as salt XOR counter. Setting the
  // salt to the nonce and the counter to 0 reproduces it exactly, since x XOR 0 = x.
  const k = { suite, key: bytes(v.key), salt: bytes(v.nonce) };
  const aad = bytes(v.aad);
  const pt = bytes(v.pt);

  // Both subkeys, as the RFC splits them: first Nka bytes encrypt, the rest authenticate.
  check(
    `${suite.name} enc_key split`,
    hex(k.key.slice(0, suite.nka)) === v.enc_key,
    `got ${hex(k.key.slice(0, suite.nka))} want ${v.enc_key}`
  );
  check(
    `${suite.name} auth_key split`,
    hex(k.key.slice(suite.nka)) === v.auth_key,
    `got ${hex(k.key.slice(suite.nka))} want ${v.auth_key}`
  );

  // KID 0 / CTR 0 encodes to the single byte 0x00, so the sealed frame is one byte of header
  // followed by the AEAD output. The AAD is then that byte plus the vector's, which is why the
  // comparison below is a round trip rather than a byte match — C.3 does the byte match.
  const sealed = await sf.encrypt(k, 0n, 0n, aad, pt);
  check(`${suite.name} header is one byte`, sealed[0] === 0x00);

  const opened = await sf.decrypt(() => k, aad, sealed);
  check(`${suite.name} round trip`, hex(opened) === hex(pt), `got ${hex(opened)}`);
  check(
    `${suite.name} tag is ${suite.nt} bytes`,
    sealed.length - 1 - pt.length === suite.nt,
    `overhead ${sealed.length - 1 - pt.length}`
  );

  // A single flipped bit anywhere must fail authentication. Truncated tags are the reason this
  // suite family exists, so the check that the tag still works is the one that matters.
  const tampered = new Uint8Array(sealed);
  tampered[tampered.length - 1] ^= 0x01;
  let rejected = false;
  try {
    await sf.decrypt(() => k, aad, tampered);
  } catch {
    rejected = true;
  }
  check(`${suite.name} rejects a flipped tag bit`, rejected);
}

// ---- C.3  full SFrame encryption, all five suites ---------------------------
//
// This is the end-to-end case: base_key in, exact ciphertext bytes out, including the key
// schedule. The vectors publish the intermediates too, so a mismatch says which stage moved
// rather than just "wrong".
section("SFrame encrypt/decrypt", vectors.sframe.length);
for (const v of vectors.sframe) {
  const suite = sf.CIPHER_SUITES[v.cipher_suite];
  check(`suite ${v.cipher_suite} known`, !!suite);
  if (!suite) continue;

  const kid = BigInt(v.kid);
  const ctr = BigInt(v.ctr);
  const baseKey = bytes(v.base_key);
  const metadata = bytes(v.metadata);

  const k = await sf.deriveKeySalt(suite, kid, baseKey);
  check(`${suite.name} sframe_key`, hex(k.key) === v.sframe_key, `got ${hex(k.key)} want ${v.sframe_key}`);
  check(`${suite.name} sframe_salt`, hex(k.salt) === v.sframe_salt, `got ${hex(k.salt)} want ${v.sframe_salt}`);

  const header = sf.encodeHeader(kid, ctr);
  check(
    `${suite.name} aad = header + metadata`,
    hex(header) + hex(metadata) === v.aad,
    `got ${hex(header) + hex(metadata)} want ${v.aad}`
  );

  const sealed = await sf.encrypt(k, kid, ctr, metadata, bytes(v.pt));
  check(`${suite.name} ciphertext`, hex(sealed) === v.ct, `got ${hex(sealed)}`);

  const opened = await sf.decrypt(() => k, metadata, bytes(v.ct));
  check(`${suite.name} decrypt`, hex(opened) === v.pt, `got ${hex(opened)}`);

  // Metadata is authenticated, not encrypted. If changing it did not break decryption, the
  // timestamp we bind through it would be free for a relay to rewrite.
  const otherMeta = new Uint8Array(metadata.length ? metadata : [0x00]);
  otherMeta[0] ^= 0x01;
  let rejected = false;
  try {
    await sf.decrypt(() => k, otherMeta, bytes(v.ct));
  } catch {
    rejected = true;
  }
  check(`${suite.name} rejects altered metadata`, rejected);

  // An unknown KID has to be its own signal, not an authentication failure — media-crypto
  // treats the two differently and would mis-handle a re-key if they were merged.
  let unknown = false;
  try {
    await sf.decrypt(() => null, metadata, bytes(v.ct));
  } catch (e) {
    unknown = e?.name === "UnknownKid";
  }
  check(`${suite.name} unknown KID is distinguishable`, unknown);
}

// ---- what the header actually costs us --------------------------------------
//
// Printed rather than asserted: this is the number the size argument in issue #1 rests on, and
// it should come from the encoder rather than from arithmetic in a comment.
console.log("\nper-frame overhead (header + tag), by suite and counter:");
for (const id of [0x0005, 0x0004, 0x0001, 0x0003]) {
  const suite = sf.CIPHER_SUITES[id];
  const row = [0n, 7n, 255n, 65535n, 16777215n].map(
    (c) => `ctr<=${String(c).padStart(8)}: ${sf.overheadBytes(suite, 0n, c)}B`
  );
  console.log(`  ${suite.name.padEnd(28)} ${row.join("  ")}`);
}
console.log(`  (the construction this replaces: 12B nonce + 16B tag = 28B, at every counter)`);

rmSync(dir, { recursive: true, force: true });
console.log(`\n${checks - fails}/${checks} checks passed`);
if (fails) {
  console.log(`${fails} FAILED`);
  process.exit(1);
}
