// Relay-blind end-to-end media encryption, using SFrame (RFC 9605) per encoded chunk.
//
// GOAL: the CDN relay (tinymoq) forwards only ciphertext it cannot read. The
// access JWT gates the *connection*; this content key gates *decryption*. They
// layer — even the relay operator, or an unauthorized connection, sees only
// opaque bytes. This is NOT DRM: an authorized viewer can still capture decoded
// frames. See PER-BROADCAST-TOKENS.md / stream-security.md §7 for scope.
//
// THE FRAME FORMAT is RFC 9605's, implemented in ./sframe.ts and checked against the SFrame
// working group's published test vectors by scripts/e2e/sframe-vectors.mjs. This file supplies
// what the RFC deliberately leaves to the application: where base_key comes from, what the KID
// and CTR mean, and how (KID, CTR) uniqueness is guaranteed. The RFC's own words, §4.4.1: "The
// process for provisioning base_key values and their KID values is beyond the scope of this
// specification, but its security properties will bound the assurances that SFrame provides."
// Ours is the `#k=` fragment of the share link, which the browser never transmits.
//
// Adopting the standard changes the *frame encryption* only. It makes no claim about key
// distribution, which remains the link and nothing else.
//
// HOW IT HOOKS IN (no public @moq API exists, so we patch the library at build
// time — see vite.config.ts `mediaCryptoPatch`, same mechanism as the existing
// `moqWebTransportOnly` patch). The legacy container frame on the wire is:
//     [varint timestamp][raw codec payload]
// We keep the varint in the clear — the container reads it — and encrypt only the payload,
// passing the varint to SFrame as `metadata` so it is authenticated without being hidden:
//     [varint timestamp][SFrame header][ciphertext + tag]
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
// NONCE UNIQUENESS is the one obligation SFrame hands back to us, and it is worth stating
// plainly because getting it wrong is not a degradation but a break. The nonce is
// salt XOR CTR, so a repeated (base_key, KID, CTR) means a repeated (key, nonce) — which under
// AES-GCM discloses the XOR of two plaintexts and yields the forgery key. The construction this
// replaced used a fresh random 96-bit nonce per frame precisely to avoid needing any such
// argument. Three things make the counter safe here:
//
//   1. ONE ENCRYPTOR. The publisher is the sole encryptor; the relay fans identical ciphertext
//      out to every viewer, which is what preserves MoQ's single-encode fan-out. So CTR is a
//      single-writer counter, incremented in one place (encryptFrame) with no await between
//      read and increment. Audio, video and the datagram rendition share it rather than keeping
//      one each — two counters over one key is exactly the collision to avoid.
//   2. KID IS MONOTONIC FOR THE LIFE OF THE PAGE and never reset (see `nextKid`). CTR restarts
//      at 0 on every re-key, so the safety of a restart rests entirely on the KID having moved.
//      It has to survive the case that actually recurs: a passcode toggled on, off and on again
//      returns to a base_key already used this session, and only a fresh KID keeps that from
//      replaying the same keystream. Because KID is in the HKDF label, a new KID means an
//      unrelated sframe_key even under an identical base_key.
//   3. A FRESH SECRET PER BROADCAST PAGE. `linkSecret` is generated at page load and never
//      restored from storage, so base_key does not survive a reload.
//
// Point 2 is also what let the group-boundary re-key machinery go. The old code held a new key
// until the next keyframe so that no group was ever split across two keys; with the generation
// named in every frame's header, a re-key can take effect immediately. What the old code was
// really protecting — a VideoDecoder fed deltas after an undecryptable keyframe — is now handled
// on the viewer, at `starved`, where the necessary information actually exists.

import {
  CIPHER_SUITES,
  decrypt as sframeDecrypt,
  deriveKeySalt,
  encrypt as sframeEncrypt,
  type SframeKey,
} from "./sframe";

const ALGO = "AES-GCM";
const NONCE_BYTES = 12;

type Mode = "publisher" | "viewer";

/**
 * An observer of incoming CIPHERTEXT frames, for viewer-side recording (src/recording.ts).
 *
 * Deliberately placed before decryption: a recorder that saw plaintext would be a second
 * place plaintext exists, and there is currently exactly one. What this hands out is the
 * bytes as they arrived, which the recorder can write to disk without holding a key.
 */
export type FrameTap = (
  frame: Uint8Array,
  trackName: string | undefined,
  firstInGroup: boolean
) => void;
let frameTap: FrameTap | null = null;

/** Install (or clear, with null) the ciphertext observer. */
export function setFrameTap(tap: FrameTap | null): void {
  frameTap = tap;
}

/**
 * The cipher suite, from the IANA registry in RFC 9605 §8.1.
 *
 * AES_256_GCM_SHA512_128 rather than the 128-bit suite, because it is what the construction
 * being replaced already used: a 256-bit AES key and a full 128-bit tag. Adopting a standard is
 * not a reason to quietly halve a key length, and our base_key is 32 bytes already.
 *
 * The RFC also defines AES-CTR + HMAC suites with 80-, 64- and 32-bit tags, which cost 6 to 12
 * fewer bytes per frame and are the obvious candidate for the datagram audio rendition. They are
 * implemented and vector-checked in sframe.ts; adopting one is a separate decision that should
 * follow a measurement, not precede it, and it is not made here.
 */
const SUITE = CIPHER_SUITES[0x0005];

/**
 * A base_key plus the per-KID (key, salt) pairs derived from it — the RFC's `key_store`.
 *
 * Derivations are cached as PROMISES, not values, so the first few frames of a stream arriving
 * together cannot each start their own HKDF for the same KID.
 */
interface Keyring {
  base: Uint8Array;
  derived: Map<string, Promise<SframeKey>>;
}

/**
 * An upper bound on KID, and on how many generations a keyring will derive.
 *
 * Our resolver is TOTAL — unlike the RFC's `key_store[KID]`, which can miss, any KID resolves
 * here, because a viewer holding the link secret can derive any generation of it. That is the
 * right behaviour (a viewer never has to be told a re-key happened) but it means the KID on the
 * wire is attacker-controlled input that costs us an HKDF and a map entry. A relay feeding
 * fabricated KIDs must not be able to grow either without bound; the frames still fail to
 * authenticate, this only stops the failing from being expensive.
 *
 * A publisher reaches KID 1 only by re-keying, which takes a human toggling a passcode.
 */
const MAX_KID = 1024n;

function keyringFor(base: Uint8Array): Keyring {
  return { base, derived: new Map() };
}

function keyFor(ring: Keyring, kid: bigint): Promise<SframeKey> {
  if (kid < 0n || kid > MAX_KID) {
    return Promise.reject(new Error(`media-crypto: KID ${kid} out of range`));
  }
  const k = kid.toString();
  let p = ring.derived.get(k);
  if (!p) {
    p = deriveKeySalt(SUITE, kid, ring.base);
    ring.derived.set(k, p);
  }
  return p;
}

// --- module state (one role per page: a broadcast page OR a watch page) ------
let mode: Mode | null = null;
let armed = false; // we KNOW this stream is encrypted; encrypt/decrypt is live
let ring: Keyring | null = null;

/**
 * The next KID to hand out, for the lifetime of the page. Deliberately NOT reset by
 * armPublisher, resetMediaKey or anything else — see point 2 of the nonce-uniqueness argument
 * at the top of this file. Resetting it is the one edit here that would silently reintroduce
 * keystream reuse, so it has no reset path at all rather than a carefully-placed one.
 */
let nextKid = 0n;

/** The generation this publisher is encrypting under, and its frame counter. */
let kid = 0n;
let ctr = 0n;

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

  // Snapshot the generation and take a counter SYNCHRONOUSLY, in one run of statements with no
  // await between them. Several chains encrypt concurrently — video groups run in parallel with
  // the audio track and with the datagram rendition — so this is the point where two frames
  // could otherwise be handed the same CTR, or one frame could be labelled with a KID and
  // encrypted under the key of the next. Everything after this line works from the snapshot.
  const r = ring;
  if (!r) throw new Error("media-crypto: encrypt with no key");
  const id = kid;
  const c = ctr++;

  const vlen = varintLen(frame[0]);
  const ts = frame.subarray(0, vlen); // cleartext timestamp, authenticated as SFrame metadata
  const payload = frame.subarray(vlen);
  const sealed = await sframeEncrypt(await keyFor(r, id), id, c, ts, payload);
  const out = new Uint8Array(vlen + sealed.byteLength);
  out.set(ts, 0);
  out.set(sealed, vlen);
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

/**
 * Tracks on which we have dropped a frame and must not resume mid-group. Viewer side only.
 *
 * This is what replaces the publisher holding a re-key until the next keyframe, and it protects
 * against strictly more than that did. The hazard has nothing to do with keys: the patched
 * consumer drops a frame it cannot decrypt and hands the FOLLOWING delta frames to the decoder,
 * and a VideoDecoder given deltas with no keyframe errors and closes. Nothing rebuilds it, so
 * the viewer stays black permanently rather than recovering at the next keyframe. A re-key was
 * only one way to reach that state; a corrupted frame or a wrong passcode entered mid-stream
 * reach it too, and the old publisher-side rule did nothing for either.
 *
 * Keyed by track so a stall on video does not mute audio. Audio recovers immediately whichever
 * way it is carried: the group path writes one group per frame and the datagram path is wrapped
 * as a single-frame group (vite.config.ts seam 4), so `firstInGroup` is true for every audio
 * frame by construction.
 */
const starved = new Set<string>();

function resetDecryptStats(): void {
  decryptFailures = 0;
  decryptSuccesses = 0;
  starved.clear();
}

/** Failures and successes since the current key was installed. */
export function decryptStats(): { failures: number; successes: number } {
  return { failures: decryptFailures, successes: decryptSuccesses };
}

async function decryptFrame(
  frame: Uint8Array,
  trackName?: string,
  firstInGroup = false
): Promise<Uint8Array> {
  // Tap BEFORE the key check: a recording should capture frames that arrive while the key is
  // still in flight, and it does not need one to store them.
  if (frameTap) {
    try {
      frameTap(frame, trackName, firstInGroup);
    } catch (e) {
      console.error("[media-crypto] frame tap threw; dropping it", e);
      frameTap = null;
    }
  }
  await keyReady;
  const r = ring;
  if (!r) throw new Error("media-crypto: decrypt with no key");
  const track = trackName ?? "";
  const vlen = varintLen(frame[0]);
  const ts = frame.subarray(0, vlen);
  const body = frame.subarray(vlen);

  let pt: Uint8Array;
  try {
    pt = await sframeDecrypt((k) => keyFor(r, k), ts, body);
  } catch (e) {
    decryptFailures++;
    starved.add(track);
    throw e;
  }

  // Decryptable, but the decoder is mid-gap. Withhold until a frame that can start one: for
  // video that is a keyframe, and delivering anything before it is what kills the decoder.
  // Deliberately NOT counted as a failure — the secret is right, which is the question the
  // counters exist to answer, and counting these would make a correct passcode look wrong.
  if (starved.has(track)) {
    if (!firstInGroup) throw new Error("media-crypto: waiting for a keyframe after a dropped frame");
    starved.delete(track);
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

/**
 * A media frame as @moq hands it to the seams.
 *
 * This CHANGED at the upgrade: `writeFrame(bytes)` became `writeFrame({ payload, timestamp })`.
 * The seam string in vite.config.ts for @moq/net's Track.writeFrame is character-identical
 * across both versions, so the patch kept applying cleanly and silently started passing an
 * object where bytes were expected. `requireFrame` below exists because of that: a shape
 * change that a string match cannot see has to be caught at the first frame instead.
 */
interface MoqFrame {
  payload: Uint8Array;
  timestamp: unknown;
}

interface GroupLike {
  writeFrame(frame: MoqFrame): void;
  close(): void;
}

/** A track that can carry a frame as a QUIC datagram rather than opening a group. */
interface TrackLike {
  appendDatagram(timestamp: unknown, payload: Uint8Array): void;
}

// Installed onto globalThis for the build-time library patch to call.
interface MediaCryptoHooks {
  shouldEncrypt(trackName?: string): boolean;
  shouldDecrypt(): boolean;
  // video path: many frames per group, group rotates on keyframe
  write(group: GroupLike, frame: MoqFrame): void;
  closeGroup(group: GroupLike): void; // chained close so pending writes flush first
  // audio path: one group per frame (Track.writeFrame), closed immediately
  writeAndClose(group: GroupLike, frame: MoqFrame): void;
  // audio-over-datagrams: no group, no stream, one datagram per frame
  writeDatagram(track: TrackLike, frame: MoqFrame): void;
  beforeDecode(frame: Uint8Array, trackName?: string, firstInGroup?: boolean): Promise<Uint8Array>;
}

/**
 * Fail loudly on the first frame if the seams are handing us a shape we do not understand.
 *
 * A build-time string match proves a string matched, not that the value flowing through it is
 * what the code assumes. When `writeFrame(bytes)` became `writeFrame({payload, timestamp})` the
 * seam still applied and the build still reported success; what changed was the meaning of the
 * argument. Encrypting `frame` instead of `frame.payload` would ship garbage, and encrypting
 * nothing would ship PLAINTEXT — which is the failure this whole module exists to prevent.
 */
function requireFrame(frame: MoqFrame, where: string): void {
  if (!frame || !(frame.payload instanceof Uint8Array)) {
    throw new Error(
      `[media-crypto] ${where}: expected a { payload: Uint8Array } frame, got ` +
        `${Object.prototype.toString.call(frame)} — the @moq frame shape moved and the seam is ` +
        `now feeding this the wrong thing. Refusing to encrypt an unknown shape.`
    );
  }
}

function install(): void {
  const hooks: MediaCryptoHooks = {
    shouldEncrypt: () => mode === "publisher" && armed,
    shouldDecrypt: () => mode === "viewer" && armed,
    write(group, frame) {
      requireFrame(frame, "write");
      const { payload, timestamp } = frame;
      chain(group, async () => {
        const enc = await encryptFrame(payload);
        try {
          group.writeFrame({ payload: enc, timestamp });
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
      requireFrame(frame, "writeAndClose");
      const { payload, timestamp } = frame;
      chain(group, async () => {
        try {
          const enc = await encryptFrame(payload);
          group.writeFrame({ payload: enc, timestamp });
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
    writeDatagram(track, frame) {
      requireFrame(frame, "writeDatagram");
      // Datagram audio takes a different route to the wire than the group path above, so it
      // needs its own encrypt call — and therefore its own chance to ship plaintext. It is
      // chained on the TRACK rather than a group, because there is no group: one datagram per
      // frame, no stream opened, which is the entire point (it is what takes an iPhone out from
      // under WebKit's ~7,600-stream ceiling).
      //
      // It shares the CTR sequence with every other encrypt call rather than keeping its own —
      // this rendition carries the SAME audio frames as the group path, so two counters over one
      // key would collide by design rather than by accident.
      const { payload, timestamp } = frame;
      chain(track as unknown as GroupLike, async () => {
        try {
          const enc = await encryptFrame(payload);
          track.appendDatagram(timestamp, enc);
        } catch (e) {
          // DROP, never fall back to sending it in the clear. A silent gap in the audio is a
          // bug; a frame on the wire that the relay can read is the product failing at the one
          // thing it claims.
          console.warn("[media-crypto] datagram dropped", e);
        }
      });
    },
    beforeDecode: (frame, trackName, firstInGroup) => decryptFrame(frame, trackName, firstInGroup ?? false),
  };
  (globalThis as unknown as { __VIVOH_MEDIA_CRYPTO__?: MediaCryptoHooks }).__VIVOH_MEDIA_CRYPTO__ =
    hooks;
}

// --- public API (used by src/main.ts) ----------------------------------------

/**
 * Arm publisher-side encryption BEFORE going live. Call as soon as the stream
 * is known to be encrypted (from its settings), even before the content key has
 * been fetched — frames produced in the meantime queue until {@link deriveMediaKey}.
 */
export function armPublisher(): void {
  if (mode === "publisher" && armed) return; // already armed — keep the pending keyReady
  mode = "publisher";
  armed = true;
  ring = null;
  resetKeyReady();
  install();
}

/** Arm viewer-side decryption BEFORE connecting to the relay. */
export function armViewer(): void {
  if (mode === "viewer" && armed) return; // already armed
  mode = "viewer";
  armed = true;
  ring = null;
  resetDecryptStats();
  resetKeyReady();
  install();
}

/**
 * Drop the current key WITHOUT un-arming (e.g. between broadcasts on the same
 * page). Subsequent frames queue until the next {@link deriveMediaKey} so a new
 * broadcast's frames are never encrypted with the previous session's key.
 */
export function resetMediaKey(): void {
  if (!armed) return;
  ring = null;
  resetKeyReady();
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

/**
 * The same derivation as {@link deriveFor}, but yielding raw bytes.
 *
 * SFrame's base_key is HKDF *input*, not an AES key — the cipher key is one HKDF expansion
 * further down, per KID (RFC 9605 §4.4.2). So this one purpose needs extractable material where
 * every other key here is deliberately non-extractable. It is the media path only: chat,
 * recordings, messages and the link watermark keep getting CryptoKeys that cannot leave the
 * browser's key store.
 */
async function deriveBitsFor(
  secretB64url: string,
  opts: DeriveOpts,
  info: string
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const ikm = (await deriveIkm(secretB64url, opts)) as BufferSource;
  const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: enc.encode(opts.salt ?? `wf-salt|${opts.streamId}`),
        info: enc.encode(info),
      },
      base,
      256
    )
  );
}

export async function deriveMediaKey(secretB64url: string, opts: DeriveOpts): Promise<void> {
  const base = await deriveBitsFor(secretB64url, opts, HKDF_INFO);

  // A publisher that is already keyed is re-keying mid-broadcast (a passcode toggled or
  // cycled). It takes effect on the very next frame: the new generation announces itself in
  // every SFrame header, so there is nothing to hold back and no group boundary to wait for.
  // The KID must advance even when the base_key is one we have used before — see point 2 of
  // the nonce-uniqueness argument at the top of this file.
  ring = keyringFor(base);
  if (mode === "publisher") {
    kid = nextKid++;
    ctr = 0n;
  }

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
 * The key that seals a recording's HEADER — its decoder config, taken from the catalog.
 *
 * Separate HKDF context from the media key, so a recording file discloses nothing (not even
 * its own resolution) to anyone without the link, while the frames inside it stay sealed under
 * the media key they arrived with. The passcode is mixed in exactly as it is for media, so a
 * protected broadcast produces a protected recording.
 */
export async function deriveRecordingKey(
  secretB64url: string,
  opts: DeriveOpts
): Promise<CryptoKey> {
  return deriveFor(secretB64url, opts, "e2emoq-recording-key-v1");
}

/**
 * The media key as a VALUE rather than as module state.
 *
 * {@link deriveMediaKey} installs into the live pipeline; replaying a recording must not
 * disturb that, because a viewer can open a recording while still watching something.
 */
export async function deriveMediaKeyStandalone(
  secretB64url: string,
  opts: DeriveOpts
): Promise<MediaKeyring> {
  return keyringFor(await deriveBitsFor(secretB64url, opts, HKDF_INFO));
}

/**
 * A media key as a value: the base_key plus whatever generations have been derived from it.
 *
 * Opaque on purpose — callers pass it back to {@link decryptFrameWith} and never look inside.
 * It is a keyring rather than a key because a recording can span a re-key, and each KID in it
 * needs its own derivation.
 */
export type MediaKeyring = Keyring;

/**
 * Open one frame under a supplied keyring — the replay path's counterpart to
 * {@link decryptFrame}, with no module state and no effect on the live decrypt statistics.
 *
 * Recordings hold frames exactly as they arrived, so this is also the compatibility boundary:
 * a file written before the SFrame cutover parses as a malformed header or fails to
 * authenticate, and cannot be opened. That was accepted deliberately rather than carried as a
 * dual-read path — see issue #1.
 */
export async function decryptFrameWith(
  ring: MediaKeyring,
  frame: Uint8Array
): Promise<Uint8Array> {
  const vlen = varintLen(frame[0]);
  const ts = frame.subarray(0, vlen);
  const pt = await sframeDecrypt((k) => keyFor(ring, k), ts, frame.subarray(vlen));
  const out = new Uint8Array(vlen + pt.byteLength);
  out.set(ts, 0);
  out.set(pt, vlen);
  return out;
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

/**
 * The key for a viewer's video message.
 *
 * Its own HKDF context, so a message is cryptographically independent of the media and of the
 * chat — but derived from the SAME link, which is what makes the whole feature work with no
 * new key exchange. Everyone holding the link can seal a message and open one; nobody else can
 * do either, including us.
 *
 * The passcode is mixed in when one is armed, so on a protected broadcast a message is
 * protected too. The salt is included for the same reason it is on media: rotating it — which
 * is how a broadcast gets terminated — must invalidate messages along with everything else.
 */
export async function deriveMessageKey(
  secretB64url: string,
  opts: DeriveOpts
): Promise<CryptoKey> {
  return deriveFor(secretB64url, opts, "e2emoq-message-key-v1");
}

/**
 * Seal arbitrary bytes to `[12-byte nonce][AES-GCM ciphertext+tag]`.
 *
 * Deliberately NOT {@link sealText}: that base64s its output, which costs 33% on a payload
 * measured in megabytes. Video messages are the only thing here big enough for that to matter,
 * so they get a binary envelope instead.
 */
export async function sealBytes(k: CryptoKey, plain: Uint8Array): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: ALGO, iv: nonce }, k, plain));
  const out = new Uint8Array(NONCE_BYTES + ct.byteLength);
  out.set(nonce, 0);
  out.set(ct, NONCE_BYTES);
  return out;
}

/** Reverse of {@link sealBytes}. Null on any failure — a wrong key must not throw. */
export async function openBytes(k: CryptoKey, sealed: Uint8Array): Promise<Uint8Array | null> {
  try {
    if (sealed.byteLength <= NONCE_BYTES) return null;
    const pt = await crypto.subtle.decrypt(
      { name: ALGO, iv: sealed.subarray(0, NONCE_BYTES) },
      k,
      sealed.subarray(NONCE_BYTES)
    );
    return new Uint8Array(pt);
  } catch {
    return null;
  }
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
  ring = null;
  starved.clear();
  keyReadyResolve?.(); // unblock any awaiters so they don't hang
  keyReady = Promise.resolve();
  keyReadyResolve = null;
  delete (globalThis as unknown as { __VIVOH_MEDIA_CRYPTO__?: MediaCryptoHooks })
    .__VIVOH_MEDIA_CRYPTO__;
}
