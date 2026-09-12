// SFrame — RFC 9605, "Secure Frame: Lightweight Authenticated Encryption for Real-Time Media".
//
// WHAT THIS IS. A faithful implementation of the RFC's frame format and key schedule, and
// nothing else. It holds no application state, reads no globals, and knows nothing about MoQ,
// tracks, groups, passcodes or share links. All of that lives in media-crypto.ts, which is the
// only caller. The split is deliberate: this file can be checked against the working group's
// published test vectors (scripts/e2e/sframe-vectors.mjs), and a file that can be checked
// against someone else's vectors is a different kind of claim from a file that cannot.
//
// WHAT THIS IS NOT. Key distribution. RFC 9605 §5 leaves that out of scope, and so does this —
// `base_key` arrives as bytes from somewhere else. In our case that somewhere is the `#k=`
// fragment of the share link (see media-crypto.ts), which the browser never transmits. Adopting
// SFrame makes our *frame encryption* standards-based; it says nothing about how the key travels.
//
// THE WIRE FORMAT (RFC 9605 §4.2, §4.3):
//
//     +-+----+-+----+--------------+--------------+
//     |X|  K |Y|  C |    Key ID    |   Counter    |  ... then ciphertext, then auth tag
//     +-+----+-+----+--------------+--------------+
//
// One config byte, then a variable-length KID and CTR. Values below 8 ride inside the config
// byte itself and cost nothing; larger ones are appended in the minimum number of bytes, with
// the 3-bit field holding that length minus one. So the whole header is ONE byte in the common
// case — which is the point, on a path where we are counting bytes per 20 ms of audio.
//
// The header is not encrypted. It is fed to the AEAD as additional authenticated data, so it
// cannot be altered undetected, but a relay can read the KID and CTR. RFC 9605 §7.1 says so
// plainly, and it is the correct trade for us: a CDN has to route, and routing metadata was
// never the thing we were hiding.
//
// THE KEY SCHEDULE (§4.4.2). base_key is never used to encrypt anything directly. Per KID:
//
//     sframe_secret = HKDF-Extract("", base_key)
//     sframe_key    = HKDF-Expand(sframe_secret, "SFrame 1.0 Secret key "  + KID + suite, Nk)
//     sframe_salt   = HKDF-Expand(sframe_secret, "SFrame 1.0 Secret salt " + KID + suite, Nn)
//
// KID is an 8-byte big-endian integer here (NOT the compressed header form) and the suite is a
// 2-byte big-endian IANA identifier. Both are in the label rather than alongside it, which is
// what makes a KID change a genuine key change: the same base_key under two KIDs yields two
// unrelated keystreams. media-crypto.ts leans on exactly that property to re-key mid-broadcast.
//
// THE NONCE (§4.4.3). salt XOR the counter, big-endian, Nn bytes. Only the counter travels.
// That is where the size saving over a transmitted random nonce comes from, and it is also the
// source of the one rule this construction imposes on its caller:
//
//     *** Every (base_key, KID, CTR) triple must be used for exactly ONE encryption. ***
//
// Reusing one is not a degradation, it is a break: two AES-GCM messages under one (key, nonce)
// disclose the XOR of their plaintexts and hand an attacker the forgery key. A random 96-bit
// nonce needs no such coordination, which is why the code this replaced used one. The counter
// is worth the obligation only because the obligation is met explicitly — see the CTR/KID
// discussion in media-crypto.ts, which is where it is met.

/** An entry from the IANA "SFrame Cipher Suites" registry (RFC 9605 §8.1, Table 2). */
export interface CipherSuite {
  /** IANA numeric identifier. Travels in the HKDF label, never on the wire. */
  id: number;
  name: string;
  /** Hash for HKDF, and for HMAC in the AES-CTR suites. */
  hash: "SHA-256" | "SHA-512";
  /** Nk — sframe_key size in bytes. For the CTR suites this spans both subkeys. */
  nk: number;
  /** Nn — nonce size in bytes. 12 for every suite defined by the RFC. */
  nn: number;
  /** Nt — authentication tag size in bytes. */
  nt: number;
  /** Nka — AES key size, AES-CTR suites only (RFC 9605 §4.5.1). */
  nka?: number;
  aead: "AES-GCM" | "AES-CTR-HMAC";
}

/** RFC 9605 §4.5 Table 1 and §8.1 Table 2, transcribed. */
export const CIPHER_SUITES: Record<number, CipherSuite> = {
  0x0001: { id: 0x0001, name: "AES_128_CTR_HMAC_SHA256_80", hash: "SHA-256", nka: 16, nk: 48, nn: 12, nt: 10, aead: "AES-CTR-HMAC" },
  0x0002: { id: 0x0002, name: "AES_128_CTR_HMAC_SHA256_64", hash: "SHA-256", nka: 16, nk: 48, nn: 12, nt: 8,  aead: "AES-CTR-HMAC" },
  0x0003: { id: 0x0003, name: "AES_128_CTR_HMAC_SHA256_32", hash: "SHA-256", nka: 16, nk: 48, nn: 12, nt: 4,  aead: "AES-CTR-HMAC" },
  0x0004: { id: 0x0004, name: "AES_128_GCM_SHA256_128",     hash: "SHA-256",           nk: 16, nn: 12, nt: 16, aead: "AES-GCM" },
  0x0005: { id: 0x0005, name: "AES_256_GCM_SHA512_128",     hash: "SHA-512",           nk: 32, nn: 12, nt: 16, aead: "AES-GCM" },
};

// --- header (§4.3) -----------------------------------------------------------

/** Minimum-length big-endian encoding. Only ever called for values >= 8. */
function minBytes(v: bigint): Uint8Array {
  const out: number[] = [];
  let x = v;
  while (x > 0n) {
    out.unshift(Number(x & 0xffn));
    x >>= 8n;
  }
  return new Uint8Array(out);
}

function beBytes(v: bigint, n: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = v;
  for (let i = n - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** The largest value either header field can carry: both are at most 8 bytes. */
const MAX_FIELD = (1n << 64n) - 1n;

/**
 * Encode an SFrame header (RFC 9605 §4.3, Figure 4).
 *
 * A value in 0..7 is carried in the config byte itself with its extended flag clear; anything
 * larger is appended after the config byte, KID first, with the 3-bit field set to the encoded
 * length minus one.
 */
export function encodeHeader(kid: bigint, ctr: bigint): Uint8Array {
  if (kid < 0n || kid > MAX_FIELD) throw new RangeError(`sframe: KID out of range: ${kid}`);
  if (ctr < 0n || ctr > MAX_FIELD) throw new RangeError(`sframe: CTR out of range: ${ctr}`);

  const kidExt = kid >= 8n;
  const ctrExt = ctr >= 8n;
  const kidBytes = kidExt ? minBytes(kid) : new Uint8Array(0);
  const ctrBytes = ctrExt ? minBytes(ctr) : new Uint8Array(0);

  const k = kidExt ? kidBytes.length - 1 : Number(kid);
  const c = ctrExt ? ctrBytes.length - 1 : Number(ctr);
  const config = ((kidExt ? 1 : 0) << 7) | (k << 4) | ((ctrExt ? 1 : 0) << 3) | c;

  const out = new Uint8Array(1 + kidBytes.length + ctrBytes.length);
  out[0] = config;
  out.set(kidBytes, 1);
  out.set(ctrBytes, 1 + kidBytes.length);
  return out;
}

export interface ParsedHeader {
  kid: bigint;
  ctr: bigint;
  /** Byte length of the header, i.e. where the ciphertext begins. */
  length: number;
}

/** Decode an SFrame header from the front of `buf`. Throws if `buf` is too short to hold it. */
export function decodeHeader(buf: Uint8Array): ParsedHeader {
  if (buf.length < 1) throw new Error("sframe: empty ciphertext, no config byte");
  const config = buf[0];
  const kidExt = (config & 0x80) !== 0;
  const k = (config >> 4) & 0x07;
  const ctrExt = (config & 0x08) !== 0;
  const c = config & 0x07;

  let off = 1;
  let kid: bigint;
  if (kidExt) {
    const n = k + 1;
    if (buf.length < off + n) throw new Error("sframe: truncated KID");
    kid = 0n;
    for (let i = 0; i < n; i++) kid = (kid << 8n) | BigInt(buf[off + i]);
    off += n;
  } else {
    kid = BigInt(k);
  }

  let ctr: bigint;
  if (ctrExt) {
    const n = c + 1;
    if (buf.length < off + n) throw new Error("sframe: truncated CTR");
    ctr = 0n;
    for (let i = 0; i < n; i++) ctr = (ctr << 8n) | BigInt(buf[off + i]);
    off += n;
  } else {
    ctr = BigInt(c);
  }

  return { kid, ctr, length: off };
}

// --- key schedule (§4.4.2) ---------------------------------------------------

/** The (key, salt) pair a single KID resolves to, plus the suite that produced it. */
export interface SframeKey {
  suite: CipherSuite;
  /** sframe_key — raw bytes, because the AES-CTR suites have to split it into two subkeys. */
  key: Uint8Array;
  /** sframe_salt — Nn bytes, XORed with the counter to form each nonce. */
  salt: Uint8Array;
}

const TEXT = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * `"SFrame 1.0 Secret key " + KID + cipher_suite` — §4.4.2.
 *
 * The trailing space in the literal is part of the label, not formatting. KID goes in as a full
 * 8-byte big-endian integer rather than the compressed header form, and the suite as 2 bytes.
 */
function label(which: "key" | "salt", kid: bigint, suiteId: number): Uint8Array {
  return concat(
    TEXT.encode(`SFrame 1.0 Secret ${which} `),
    beBytes(kid, 8),
    beBytes(BigInt(suiteId), 2)
  );
}

/**
 * derive_key_salt(KID, base_key) — RFC 9605 §4.4.2.
 *
 * Web Crypto's HKDF does Extract-then-Expand in one call, so each deriveBits here is
 * `HKDF-Expand(HKDF-Extract("", base_key), label, L)` exactly as the RFC specifies. An empty
 * salt and a salt of HashLen zero bytes are the same input to HMAC, so `new Uint8Array(0)` is
 * the RFC's `""`.
 */
export async function deriveKeySalt(
  suite: CipherSuite,
  kid: bigint,
  baseKey: Uint8Array
): Promise<SframeKey> {
  const ikm = await crypto.subtle.importKey("raw", baseKey as BufferSource, "HKDF", false, ["deriveBits"]);
  const expand = async (which: "key" | "salt", bytes: number) =>
    new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "HKDF",
          hash: suite.hash,
          salt: new Uint8Array(0),
          info: label(which, kid, suite.id) as BufferSource,
        },
        ikm,
        bytes * 8
      )
    );
  const [key, salt] = await Promise.all([expand("key", suite.nk), expand("salt", suite.nn)]);
  return { suite, key, salt };
}

// --- AEAD --------------------------------------------------------------------

/** nonce = sframe_salt XOR encode_big_endian(CTR, Nn) — §4.4.3. */
function nonceFor(k: SframeKey, ctr: bigint): Uint8Array {
  const out = beBytes(ctr, k.suite.nn);
  for (let i = 0; i < out.length; i++) out[i] ^= k.salt[i];
  return out;
}

/**
 * compute_tag — §4.5.1.
 *
 * The three lengths are authenticated alongside the data, which is what keeps an attacker from
 * shifting bytes between the AAD and the ciphertext. Nt is in there too, so a short tag cannot
 * be passed off as a prefix of a long one.
 */
async function computeTag(
  suite: CipherSuite,
  authKey: CryptoKey,
  nonce: Uint8Array,
  aad: Uint8Array,
  ct: Uint8Array
): Promise<Uint8Array> {
  const authData = concat(
    beBytes(BigInt(aad.length), 8),
    beBytes(BigInt(ct.length), 8),
    beBytes(BigInt(suite.nt), 8),
    nonce,
    aad,
    ct
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", authKey, authData as BufferSource));
  return mac.subarray(0, suite.nt);
}

/** derive_subkeys — §4.5.1. First Nka bytes encrypt; the remaining Nh bytes authenticate. */
async function subkeys(suite: CipherSuite, sframeKey: Uint8Array) {
  const nka = suite.nka!;
  const [encKey, authKey] = await Promise.all([
    crypto.subtle.importKey("raw", sframeKey.slice(0, nka) as BufferSource, "AES-CTR", false, ["encrypt", "decrypt"]),
    crypto.subtle.importKey("raw", sframeKey.slice(nka) as BufferSource, { name: "HMAC", hash: suite.hash }, false, ["sign"]),
  ]);
  return { encKey, authKey };
}

/** `initial_counter = nonce + 0x00000000` — a 16-byte block whose low 32 bits are the counter. */
function initialCounter(nonce: Uint8Array): Uint8Array {
  const ctr = new Uint8Array(16);
  ctr.set(nonce, 0);
  return ctr;
}

/** Length-independent comparison. JS gives no real guarantee here; it is still worth not leaking. */
function equalCT(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function aeadEncrypt(
  k: SframeKey,
  nonce: Uint8Array,
  aad: Uint8Array,
  pt: Uint8Array
): Promise<Uint8Array> {
  if (k.suite.aead === "AES-GCM") {
    const key = await crypto.subtle.importKey("raw", k.key as BufferSource, "AES-GCM", false, ["encrypt"]);
    return new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce as BufferSource, additionalData: aad as BufferSource, tagLength: k.suite.nt * 8 },
        key,
        pt as BufferSource
      )
    );
  }
  const { encKey, authKey } = await subkeys(k.suite, k.key);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-CTR", counter: initialCounter(nonce) as BufferSource, length: 32 },
      encKey,
      pt as BufferSource
    )
  );
  const tag = await computeTag(k.suite, authKey, nonce, aad, ct);
  return concat(ct, tag);
}

async function aeadDecrypt(
  k: SframeKey,
  nonce: Uint8Array,
  aad: Uint8Array,
  ct: Uint8Array
): Promise<Uint8Array> {
  if (k.suite.aead === "AES-GCM") {
    const key = await crypto.subtle.importKey("raw", k.key as BufferSource, "AES-GCM", false, ["decrypt"]);
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce as BufferSource, additionalData: aad as BufferSource, tagLength: k.suite.nt * 8 },
        key,
        ct as BufferSource
      )
    );
  }
  if (ct.length < k.suite.nt) throw new Error("sframe: ciphertext shorter than its tag");
  const inner = ct.subarray(0, ct.length - k.suite.nt);
  const tag = ct.subarray(ct.length - k.suite.nt);
  const { encKey, authKey } = await subkeys(k.suite, k.key);
  const candidate = await computeTag(k.suite, authKey, nonce, aad, inner);
  if (!equalCT(tag, candidate)) throw new Error("sframe: authentication failure");
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-CTR", counter: initialCounter(nonce) as BufferSource, length: 32 },
      encKey,
      inner as BufferSource
    )
  );
}

// --- the two operations (§4.4.3, §4.4.4) -------------------------------------

/**
 * encrypt(CTR, KID, metadata, plaintext) — returns `header + ciphertext`.
 *
 * `metadata` is authenticated but not encrypted: it is appended to the header to form the AAD.
 * We use it for the media timestamp, which the MoQ container has to be able to read in the clear
 * and which we nevertheless want protected from a relay that might rewrite it.
 *
 * The caller supplies CTR and is responsible for never repeating one under a given (base_key,
 * KID). See the header comment.
 */
export async function encrypt(
  k: SframeKey,
  kid: bigint,
  ctr: bigint,
  metadata: Uint8Array,
  plaintext: Uint8Array
): Promise<Uint8Array> {
  const header = encodeHeader(kid, ctr);
  const aad = metadata.length ? concat(header, metadata) : header;
  const ct = await aeadEncrypt(k, nonceFor(k, ctr), aad, plaintext);
  return concat(header, ct);
}

/**
 * Thrown when the header names a KID the resolver does not hold.
 *
 * Distinct from an authentication failure on purpose. "I have no key with this label" and "I
 * have the key and the bytes did not verify" are different events with different remedies — the
 * first is a re-key we have not caught up with, the second is a wrong secret or a tampered
 * frame. RFC 9605 §4.4.4 lets a receiver buffer and retry on the first and requires it to
 * discard on the second, which it can only do if it can tell them apart.
 */
export class UnknownKid extends Error {
  constructor(readonly kid: bigint) {
    super(`sframe: no key for KID ${kid}`);
    this.name = "UnknownKid";
  }
}

/**
 * decrypt(metadata, sframe_ciphertext) — RFC 9605 §4.4.4.
 *
 * `resolve` is the RFC's `key_store[KID]`: it maps the KID on the wire to a derived (key, salt).
 * Returning null means "no key with that label" and raises {@link UnknownKid}.
 */
export async function decrypt(
  resolve: (kid: bigint) => Promise<SframeKey | null> | SframeKey | null,
  metadata: Uint8Array,
  sframeCiphertext: Uint8Array
): Promise<Uint8Array> {
  const { kid, ctr, length } = decodeHeader(sframeCiphertext);
  const k = await resolve(kid);
  if (!k) throw new UnknownKid(kid);
  const header = sframeCiphertext.subarray(0, length);
  const ct = sframeCiphertext.subarray(length);
  const aad = metadata.length ? concat(header, metadata) : header;
  return aeadDecrypt(k, nonceFor(k, ctr), aad, ct);
}

/**
 * Bytes this construction adds to a frame, for a given KID and CTR.
 *
 * Exported so the size claim can be computed rather than estimated — see
 * scripts/e2e/sframe-vectors.mjs, and the measurement recorded in issue #1.
 */
export function overheadBytes(suite: CipherSuite, kid: bigint, ctr: bigint): number {
  return encodeHeader(kid, ctr).length + suite.nt;
}
