// Relay-blind end-to-end media encryption (AES-GCM per encoded chunk).
//
// GOAL: the CDN relay (tinymoq) forwards only ciphertext it cannot read. The
// access JWT gates the *connection*; this content key gates *decryption*. They
// layer — even the relay operator, or an unauthorized connection, sees only
// opaque bytes. This is NOT DRM: an authorized viewer can still capture decoded
// frames. See PER-BROADCAST-TOKENS.md / stream-security.md §7 for scope.
//
// HOW IT HOOKS IN (no public @moq API exists, so we patch the library at build
// time — see vite.config.ts `mediaCryptoPatch`, same mechanism as the existing
// `moqWebTransportOnly` patch). The legacy container frame on the wire is:
//     [varint timestamp][raw codec payload]
// We keep the varint in the clear (the container reads it, and we bind it as
// AES-GCM additional-authenticated-data) and encrypt only the payload:
//     [varint timestamp][12-byte nonce][AES-GCM ciphertext + 16-byte tag]
// MoQ object/group framing is untouched, so the relay still routes groups and
// keyframe boundaries exactly as before. The catalog (codec config / SPS-PPS)
// travels via writeJson, NOT through these seams, so it stays in the clear by
// design (decision: leak codec/resolution metadata, never content).
//
// The patched library code reaches us through a page-scoped global
// (`globalThis.__VIVOH_MEDIA_CRYPTO__`) that we install when a key is
// provisioned. The global is never exposed to the relay (the relay never runs
// our JS). When no key is armed, the global is absent and the library behaves
// byte-for-byte as upstream (passthrough).
//
// NONCE: a fresh 12-byte random nonce per chunk, carried in the frame. The
// publisher is the sole encryptor (the relay fans out identical ciphertext to
// every viewer — that is what preserves MoQ single-encode fan-out), so nonce
// uniqueness is a single-writer problem; random 96-bit nonces are safe well
// past our per-session frame counts and need no cross-track / cross-reconnect
// coordination (the failure mode of counters). The GCM auth tag additionally
// gives integrity for free: a tampering/injecting relay fails decryption.

const ALGO = "AES-GCM";
const NONCE_BYTES = 12;

type Mode = "publisher" | "viewer";

// --- module state (one role per page: a broadcast page OR a watch page) ------
let mode: Mode | null = null;
let armed = false; // we KNOW this stream is encrypted; encrypt/decrypt is live
let key: CryptoKey | null = null;

// A re-key that is waiting for a group boundary. Publisher side only.
//
// Swapping the key the instant a passcode changes splits the group in flight: its keyframe is
// encrypted under the old key and its tail under the new one. That group is then undecodable
// by EVERYONE — the old passcode fails on the tail, and a viewer arriving with the new one
// fails on the keyframe. The second case is the damaging one, because the patched consumer
// drops the frame it cannot decrypt and hands the FOLLOWING delta frames to the decoder. A
// VideoDecoder given deltas with no keyframe errors and closes, and nothing rebuilds it, so
// the viewer stays black permanently rather than recovering at the next keyframe.
//
// Holding the new key until the next group makes "one group, one key" an invariant, which is
// what the decoder actually requires. Cost: viewers holding the OLD passcode keep decrypting
// until the next keyframe — up to keyframeInterval, 2s by default.
let pendingKey: CryptoKey | null = null;

// Whether this publisher has produced any video group. Audio writes one group per frame, so
// on an audio-only broadcast it is the only thing that can carry a pending key forward.
let sawVideoGroup = false;

/** Install a re-key that was held for a group boundary. */
function promotePendingKey(): void {
  if (!pendingKey) return;
  key = pendingKey;
  pendingKey = null;
  keyReadyResolve?.();
}
// Frames can be produced before the key arrives (encoder warms up while the
// /assign + key fetch is in flight). We arm encryption immediately and make the
// per-frame work await this promise, so nothing is ever published in the clear.
let keyReady: Promise<void> = Promise.resolve();
let keyReadyResolve: (() => void) | null = null;

function resetKeyReady(): void {
  keyReady = new Promise<void>((resolve) => {
    keyReadyResolve = resolve;
  });
}

// QUIC varint length from the first byte (RFC 9000 §16: top 2 bits select 1/2/4/8).
function varintLen(first: number): number {
  return 1 << ((first & 0xc0) >> 6);
}

function b64urlToBytes(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = norm + "=".repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(padded);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function encryptFrame(frame: Uint8Array): Promise<Uint8Array> {
  await keyReady;
  if (!key) throw new Error("media-crypto: encrypt with no key");
  const vlen = varintLen(frame[0]);
  const ts = frame.subarray(0, vlen); // cleartext timestamp + AAD
  const payload = frame.subarray(vlen);
  const nonce = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(nonce);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: ALGO, iv: nonce, additionalData: ts }, key, payload)
  );
  const out = new Uint8Array(vlen + NONCE_BYTES + ct.byteLength);
  out.set(ts, 0);
  out.set(nonce, vlen);
  out.set(ct, vlen + NONCE_BYTES);
  return out;
}

// Frames that failed AES-GCM authentication. A wrong passcode (or a stale salt) produces a
// wrong key rather than an error anywhere in the system, so this counter is the only signal
// distinguishing "wrong secret" from "stream not started yet" -- both otherwise look like a
// black player. Deliberately no server is involved: nothing can confirm or deny a guess.
let decryptFailures = 0;
// Counted alongside, because failures alone cannot tell "wrong secret" from "right secret,
// and a handful of frames from before it was installed". Only a viewer that has decrypted
// NOTHING has actually got the wrong secret.
let decryptSuccesses = 0;

function resetDecryptStats(): void {
  decryptFailures = 0;
  decryptSuccesses = 0;
}

/** Failures and successes since the current key was installed. */
export function decryptStats(): { failures: number; successes: number } {
  return { failures: decryptFailures, successes: decryptSuccesses };
}

async function decryptFrame(frame: Uint8Array): Promise<Uint8Array> {
  await keyReady;
  if (!key) throw new Error("media-crypto: decrypt with no key");
  const vlen = varintLen(frame[0]);
  const ts = frame.subarray(0, vlen);
  const nonce = frame.subarray(vlen, vlen + NONCE_BYTES);
  const ct = frame.subarray(vlen + NONCE_BYTES);
  let pt: Uint8Array;
  try {
    pt = new Uint8Array(
      await crypto.subtle.decrypt({ name: ALGO, iv: nonce, additionalData: ts }, key, ct)
    );
  } catch (e) {
    decryptFailures++;
    throw e;
  }
  decryptSuccesses++;
  const out = new Uint8Array(vlen + pt.byteLength);
  out.set(ts, 0);
  out.set(pt, vlen);
  return out;
}

// Per-group ordering: AES-GCM is async, but frames within a group must stay in
// order. Each group gets a promise chain so writes serialize even though the
// encoder calls writeFrame synchronously and doesn't await us.
const chains = new WeakMap<object, Promise<unknown>>();
function chain(group: object, task: () => Promise<void>): void {
  const prev = chains.get(group) ?? Promise.resolve();
  const next = prev.then(task).catch((e) => {
    console.error("[media-crypto] frame task failed (frame dropped):", e);
  });
  chains.set(group, next);
}

interface GroupLike {
  writeFrame(frame: Uint8Array): void;
  close(): void;
}

// Installed onto globalThis for the build-time library patch to call.
interface MediaCryptoHooks {
  shouldEncrypt(trackName?: string): boolean;
  shouldDecrypt(): boolean;
  // video path: many frames per group, group rotates on keyframe
  write(group: GroupLike, frame: Uint8Array): void;
  closeGroup(group: GroupLike): void; // chained close so pending writes flush first
  // audio path: one group per frame (Track.writeFrame), closed immediately
  writeAndClose(group: GroupLike, frame: Uint8Array): void;
  beforeDecode(frame: Uint8Array): Promise<Uint8Array>;
}

function install(): void {
  const hooks: MediaCryptoHooks = {
    shouldEncrypt: () => mode === "publisher" && armed,
    shouldDecrypt: () => mode === "viewer" && armed,
    write(group, frame) {
      // The first write to a group is its keyframe — the only safe moment to change key.
      if (!chains.has(group)) {
        sawVideoGroup = true;
        promotePendingKey();
      }
      chain(group, async () => {
        const enc = await encryptFrame(frame);
        try {
          group.writeFrame(enc);
        } catch {
          /* group already closed — drop */
        }
      });
    },
    closeGroup(group) {
      chain(group, async () => {
        try {
          group.close();
        } catch {
          /* already closed */
        }
      });
    },
    writeAndClose(group, frame) {
      // Audio has no keyframe dependency: every frame is its own group, so a viewer recovers
      // on the next frame regardless. Only carry a pending re-key here when there is no video
      // to wait for, otherwise audio would run ahead of the video keyframe and re-split it.
      if (!sawVideoGroup) promotePendingKey();
      chain(group, async () => {
        try {
          const enc = await encryptFrame(frame);
          group.writeFrame(enc);
        } catch {
          /* drop */
        } finally {
          try {
            group.close();
          } catch {
            /* already closed */
          }
        }
      });
    },
    beforeDecode: (frame) => decryptFrame(frame),
  };
  (globalThis as unknown as { __VIVOH_MEDIA_CRYPTO__?: MediaCryptoHooks }).__VIVOH_MEDIA_CRYPTO__ =
    hooks;
}

// --- public API (used by src/main.ts) ----------------------------------------

/**
 * Arm publisher-side encryption BEFORE going live. Call as soon as the stream
 * is known to be encrypted (from its settings), even before the content key has
 * been fetched — frames produced in the meantime queue until {@link setMediaKey}.
 */
export function armPublisher(): void {
  if (mode === "publisher" && armed) return; // already armed — keep the pending keyReady
  mode = "publisher";
  armed = true;
  key = null;
  pendingKey = null;
  sawVideoGroup = false;
  resetKeyReady();
  install();
}

/** Arm viewer-side decryption BEFORE connecting to the relay. */
export function armViewer(): void {
  if (mode === "viewer" && armed) return; // already armed
  mode = "viewer";
  armed = true;
  key = null;
  pendingKey = null;
  resetDecryptStats();
  resetKeyReady();
  install();
}

/**
 * Drop the current key WITHOUT un-arming (e.g. between broadcasts on the same
 * page). Subsequent frames queue until the next {@link setMediaKey} so a new
 * broadcast's frames are never encrypted with the previous session's key.
 */
export function resetMediaKey(): void {
  if (!armed) return;
  key = null;
  pendingKey = null;
  sawVideoGroup = false;
  resetKeyReady();
}

/** Import the per-broadcast content key (base64url, 256-bit) and release queued frames. */
export async function setMediaKey(b64url: string): Promise<void> {
  const raw = b64urlToBytes(b64url);
  key = await crypto.subtle.importKey("raw", raw, { name: ALGO }, false, ["encrypt", "decrypt"]);
  keyReadyResolve?.();
}

/** Context version. Bumping it re-keys every stream, invalidating existing share links. */
const HKDF_INFO = "e2emoq-content-key-v1";

/**
 * An 8-character passcode, drawn from an alphabet with no visually ambiguous characters
 * (no O/0, no I/l/1). It is meant to be spoken aloud or typed from a text message, so
 * legibility matters more than density. 31^8 is ~10^12 combinations, which is ample given
 * that guessing is unverifiable: there is no oracle anywhere to test a guess against, so an
 * attacker learns nothing except that a stream failed to play.
 */
export function generatePasscode(): string {
  const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const raw = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(raw, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

/** A fresh 32-byte link secret, base64url. This value is the whole capability. */
export function generateLinkSecret(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Derive the content key from the secret carried in the share link's `#k=` fragment.
 *
 * The fragment is the point of the whole design: browsers never transmit it, so this
 * secret cannot reach our Worker, our logs, or the CDN even by accident. Whoever holds the
 * link can decrypt; nobody else can, including us.
 *
 * The secret is HKDF input rather than the key itself so that other material can be mixed
 * in without changing the link format:
 *   - `salt`   — a rotatable per-stream value; rotating it re-keys the stream and revokes
 *                existing viewers. Until that is wired up, the stream id stands in, which
 *                is public and needs no storage.
 *   - `passcode` — an optional second secret deliberately kept OUT of the link and sent by
 *                another channel, so the link alone is not sufficient.
 *
 * A wrong passcode or a stale salt yields a wrong key rather than an error: decryption
 * simply fails, and no server is ever in a position to confirm or deny a guess.
 */
export interface DeriveOpts {
  streamId: string;
  salt?: string;
  passcode?: string;
}

/**
 * Shared input keying material: the link secret, optionally with a stretched passcode mixed
 * in. Both the media key and the chat key derive from this, so a passcode protects the whole
 * session and rotating a salt re-keys all of it at once.
 */
async function deriveIkm(secretB64url: string, opts: DeriveOpts): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const ikm = b64urlToBytes(secretB64url);
  if (!opts.passcode) return ikm;

  // Stretch the passcode before mixing so a short, human-chosen value is not the weak link.
  const pk = await crypto.subtle.importKey("raw", enc.encode(opts.passcode), "PBKDF2", false, ["deriveBits"]);
  const stretched = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(`wf-pass|${opts.streamId}`), iterations: 210000 },
      pk,
      256
    )
  );
  const mixed = new Uint8Array(ikm.length + stretched.length);
  mixed.set(ikm, 0);
  mixed.set(stretched, ikm.length);
  return mixed;
}

/**
 * One AES-GCM key from the shared material. `info` separates purposes: media and chat get
 * cryptographically independent keys from the same secret, so neither can decrypt the other
 * even though both come from one link.
 */
async function deriveFor(secretB64url: string, opts: DeriveOpts, info: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", await deriveIkm(secretB64url, opts), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode(opts.salt ?? `wf-salt|${opts.streamId}`),
      info: enc.encode(info),
    },
    base,
    { name: ALGO, length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function deriveMediaKey(secretB64url: string, opts: DeriveOpts): Promise<void> {
  const derived = await deriveFor(secretB64url, opts, HKDF_INFO);

  // A publisher that is already keyed is re-keying mid-broadcast (a passcode toggled or
  // cycled). Hold it for the next group so no group is ever split across two keys — see
  // pendingKey. Every other case is a first install and takes effect immediately.
  if (mode === "publisher" && key) {
    pendingKey = derived;
    return;
  }

  key = derived;
  // A viewer re-deriving has a new secret and is about to be judged on it; failures counted
  // against the previous key would otherwise make a correct passcode look wrong.
  if (mode === "viewer") resetDecryptStats();
  keyReadyResolve?.();
}

/**
 * The chat key. Separate from the media key by HKDF info, so the Durable Object that relays
 * chat sees ciphertext exactly as the CDN sees ciphertext video — and a compromise of one
 * key does not yield the other.
 */
export async function deriveChatKey(secretB64url: string, opts: DeriveOpts): Promise<CryptoKey> {
  return deriveFor(secretB64url, opts, "e2emoq-chat-key-v1");
}

/**
 * The key for the broadcaster's Link watermark.
 *
 * The QR itself needs no key — it is drawn into the picture and encrypted with every other
 * pixel. This exists for the other half of the feature: someone watching on the same device
 * cannot point a phone at their own screen, so the URL also has to arrive as text they can
 * tap.
 *
 * Text has to be stored somewhere both ends can reach, which means our Worker — and a plain
 * URL in a database row would quietly undo the property the QR had for free. So the
 * broadcaster seals it under this key before it leaves the browser and the viewer opens it
 * with the same one, derived from the `#k=` fragment neither the Worker nor the CDN ever
 * sees. What gets stored is an opaque blob: where a broadcaster points their audience stays
 * exactly as private as what they are broadcasting.
 */
export async function deriveLinkKey(secretB64url: string, opts: DeriveOpts): Promise<CryptoKey> {
  return deriveFor(secretB64url, opts, "e2emoq-link-key-v1");
}

/**
 * Proof that the caller holds the share link, for /route.
 *
 * Without this, the Worker mints a viewer token to anyone who knows a five-character stream
 * id — an id space small enough to sweep. That never exposed content (the ciphertext is
 * useless without the fragment), but it made this account an open tap for our own CDN egress
 * and told a stranger who was broadcasting and when.
 *
 * The publisher hands this value to the Worker at go-live; viewers derive the identical value
 * from the fragment they already hold. It is a bearer proof, not an identity — everyone with
 * the link computes the same tag, which is exactly right for a capability system.
 *
 * Two deliberate differences from the media key:
 *
 *   - Different HKDF `info` AND a different salt, so the tag is cryptographically independent
 *     of the content key. Handing it to the Worker gives the Worker no path to decryption.
 *   - The passcode is NOT mixed in. A viewer calls /route before being prompted for one, and
 *     the publisher sets it independently; including it would make the tag underivable at the
 *     moment it is needed. The passcode protects CONTENT, which is a separate job.
 *
 * The server-rotated salt is likewise excluded: it arrives IN the /route response, so
 * depending on it here would be circular.
 */
export async function deriveRouteTag(secretB64url: string, streamId: string): Promise<string> {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", b64urlToBytes(secretB64url), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode(`wf-route|${streamId}`),
      info: enc.encode("e2emoq-route-auth-v1"),
    },
    base,
    256
  );
  return btoa(String.fromCharCode(...new Uint8Array(bits)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Encrypt a UTF-8 string to `<b64url nonce>.<b64url ciphertext>`. */
export async function sealText(k: CryptoKey, plaintext: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: ALGO, iv: nonce }, k, new TextEncoder().encode(plaintext))
  );
  const b64 = (b: Uint8Array) =>
    btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64(nonce)}.${b64(ct)}`;
}

/** Reverse of {@link sealText}. Returns null on any failure — a wrong key must not throw. */
export async function openText(k: CryptoKey, sealed: string): Promise<string | null> {
  try {
    const [n, c] = sealed.split(".");
    if (!n || !c) return null;
    const pt = await crypto.subtle.decrypt(
      { name: ALGO, iv: b64urlToBytes(n) },
      k,
      b64urlToBytes(c)
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

/** Tear down: clears the key and removes the global so the library reverts to passthrough. */
export function clearMediaCrypto(): void {
  mode = null;
  armed = false;
  key = null;
  keyReadyResolve?.(); // unblock any awaiters so they don't hang
  keyReady = Promise.resolve();
  keyReadyResolve = null;
  delete (globalThis as unknown as { __VIVOH_MEDIA_CRYPTO__?: MediaCryptoHooks })
    .__VIVOH_MEDIA_CRYPTO__;
}
