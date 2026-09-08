// Viewer-side recording — save a broadcast and watch it again with the same link.
//
// THE WHOLE POINT: this feature adds NO new access to plaintext, on either side.
//
// The frames we write to disk are the exact ciphertext that came off the wire. We do not
// decrypt, re-encode, or re-encrypt them — recording is literally "append these bytes". That
// means the file inherits the stream's property for free: it is opaque without the `#k=`
// fragment, and this Worker could not read a recording if it were handed one. There is also
// no way for me to get the encryption wrong here, because I am not doing any.
//
// Capture point is the decrypt seam (`beforeDecode`, see vite.config.ts). It sees every
// incoming frame for BOTH tracks before decryption, which is why one tap covers audio and
// video with no dependency on the player's internals.
//
// WHAT IS NOT ENCRYPTED, and why it does not matter: the file header carries the WebCodecs
// decoder config (codec, resolution, description) taken from the catalog. That catalog travels
// in the clear on the wire already, by documented decision — the relay must route on it. But a
// file sitting on a disk is a different exposure from a packet in flight, so the header is
// sealed anyway, under its own HKDF context. A recording therefore reveals not even its own
// resolution without the link.
//
// WIRE FORMAT
//   "E2MQREC1"                       8 bytes, magic
//   u32                              sealed-header length
//   <sealed header>                  sealText(recordingKey, JSON) as UTF-8
//   then, repeated to EOF:
//     u8   track                     0 = video, 1 = audio
//     u8   flags                     bit0 = first frame of its group (keyframe for video)
//     u32  length
//     ...  the encrypted frame, byte for byte as it arrived

import {
  deriveRecordingKey,
  deriveMediaKeyStandalone,
  openText,
  sealText,
  setFrameTap,
  decryptFrameWith,
} from "./crypto/media-crypto";

const MAGIC = "E2MQREC1";
const TRACK_VIDEO = 0;
const TRACK_AUDIO = 1;

/** Guardrail: a runaway tab should not eat the disk. ~512 MB of ciphertext. */
const MAX_BYTES = 512 * 1024 * 1024;

export interface RecordingHeader {
  v: 1;
  streamId: string;
  created: number;
  /**
   * The per-stream salt that was in force while recording. The Worker rotates this to revoke
   * live viewers, so a recording made under one salt needs that same value to reopen — the
   * current one will not do. It lives inside the SEALED header, so carrying it here discloses
   * nothing: it is already a value the server knows and the link does not.
   */
  salt?: string;
  /** True if a passcode was mixed in. Replay must ask for it; we never store it. */
  passcoded?: boolean;
  /** WebCodecs VideoDecoderConfig, from the catalog. `description` is hex. */
  video?: Record<string, unknown>;
  /** WebCodecs AudioDecoderConfig, from the catalog. */
  audio?: Record<string, unknown>;
}

interface CapturedFrame {
  track: number;
  first: boolean;
  bytes: Uint8Array;
}

// ---------------------------------------------------------------- capture

let frames: CapturedFrame[] = [];
let bytes = 0;
let recording = false;
let overflowed = false;
let videoTrackName: string | null = null;

/** Bytes buffered so far, for the UI. */
export function recordedBytes(): number {
  return bytes;
}

export function isRecording(): boolean {
  return recording;
}

/** True when we stopped early because the buffer hit {@link MAX_BYTES}. */
export function didOverflow(): boolean {
  return overflowed;
}

/**
 * Begin buffering. `videoTrack` is the catalog's video track name, used to sort frames into
 * the right decoder — the seam reports a track name but nothing about what kind of track it is.
 * When it is unknown we fall back to group shape: audio publishes one frame per group, so a
 * frame that is NOT the first of its group is necessarily video.
 */
export function startRecording(videoTrack?: string | null): void {
  frames = [];
  bytes = 0;
  overflowed = false;
  recording = true;
  videoTrackName = videoTrack ?? null;

  setFrameTap((frame, trackName, firstInGroup) => {
    if (!recording) return;
    if (bytes + frame.byteLength > MAX_BYTES) {
      overflowed = true;
      recording = false;
      setFrameTap(null);
      return;
    }
    const isVideo =
      videoTrackName && trackName ? trackName === videoTrackName : !firstInGroup;
    frames.push({
      track: isVideo ? TRACK_VIDEO : TRACK_AUDIO,
      first: firstInGroup,
      // Copy: the caller reuses its buffer, and a view into it would decay under us.
      bytes: frame.slice(),
    });
    bytes += frame.byteLength;
  });
}

/**
 * Stop buffering and serialise. Returns null when nothing was captured, so the caller can say
 * "nothing to save" rather than handing the user an empty file.
 */
export async function stopRecording(
  secret: string,
  header: Omit<RecordingHeader, "v" | "created">
): Promise<Blob | null> {
  recording = false;
  setFrameTap(null);
  if (!frames.length) return null;

  const full: RecordingHeader = { v: 1, created: Date.now(), ...header };
  const key = await deriveRecordingKey(secret, { streamId: header.streamId });
  const sealed = new TextEncoder().encode(await sealText(key, JSON.stringify(full)));

  const total =
    MAGIC.length + 4 + sealed.byteLength + frames.reduce((n, f) => n + 6 + f.bytes.byteLength, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let o = 0;

  for (let i = 0; i < MAGIC.length; i++) out[o++] = MAGIC.charCodeAt(i);
  view.setUint32(o, sealed.byteLength);
  o += 4;
  out.set(sealed, o);
  o += sealed.byteLength;

  for (const f of frames) {
    out[o++] = f.track;
    out[o++] = f.first ? 1 : 0;
    view.setUint32(o, f.bytes.byteLength);
    o += 4;
    out.set(f.bytes, o);
    o += f.bytes.byteLength;
  }

  frames = [];
  bytes = 0;
  return new Blob([out], { type: "application/octet-stream" });
}

/** Drop everything buffered without producing a file. */
export function cancelRecording(): void {
  recording = false;
  setFrameTap(null);
  frames = [];
  bytes = 0;
}

// ---------------------------------------------------------------- parsing

export interface ParsedRecording {
  header: RecordingHeader;
  frames: CapturedFrame[];
}

/**
 * Read a recording. Returns null when the file is not one of ours, or when the secret does not
 * open the header — which is the same failure a viewer gets with the wrong link, and is
 * deliberately not distinguishable from it.
 */
export async function parseRecording(
  buf: ArrayBuffer,
  secret: string,
  streamId: string
): Promise<ParsedRecording | null> {
  const u8 = new Uint8Array(buf);
  if (u8.byteLength < MAGIC.length + 4) return null;
  for (let i = 0; i < MAGIC.length; i++) {
    if (u8[i] !== MAGIC.charCodeAt(i)) return null;
  }

  const view = new DataView(buf);
  let o = MAGIC.length;
  const headerLen = view.getUint32(o);
  o += 4;
  if (o + headerLen > u8.byteLength) return null;

  const sealed = new TextDecoder().decode(u8.subarray(o, o + headerLen));
  o += headerLen;

  const key = await deriveRecordingKey(secret, { streamId });
  const plain = await openText(key, sealed);
  if (!plain) return null;

  let header: RecordingHeader;
  try {
    header = JSON.parse(plain) as RecordingHeader;
  } catch {
    return null;
  }

  const out: CapturedFrame[] = [];
  while (o + 6 <= u8.byteLength) {
    const track = u8[o++];
    const first = u8[o++] === 1;
    const len = view.getUint32(o);
    o += 4;
    if (o + len > u8.byteLength) break; // truncated tail — keep what decoded
    out.push({ track, first, bytes: u8.subarray(o, o + len) });
    o += len;
  }

  return { header, frames: out };
}

// ---------------------------------------------------------------- replay

/** QUIC varint (RFC 9000 §16): the top 2 bits of byte 0 select 1/2/4/8. */
function readVarint(b: Uint8Array): { value: number; len: number } {
  const len = 1 << ((b[0] & 0xc0) >> 6);
  let value = b[0] & 0x3f;
  for (let i = 1; i < len; i++) value = value * 256 + b[i];
  return { value, len };
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export interface PlaybackHandle {
  stop(): void;
  /** Resolves when playback reaches the end, or is stopped. */
  done: Promise<void>;
}

/**
 * Decode a parsed recording to `canvas`, with audio through a fresh AudioContext.
 *
 * Timing comes from the frame timestamps that were on the wire, replayed against wall clock
 * from the first frame — so a recording plays at the rate it was broadcast, including any
 * gaps where the broadcaster's network stalled. That is a faithful record rather than a
 * flattering one.
 */
export async function playRecording(
  parsed: ParsedRecording,
  secret: string,
  canvas: HTMLCanvasElement,
  opts: {
    passcode?: string;
    onProgress?: (seconds: number) => void;
    onEnd?: () => void;
  } = {}
): Promise<PlaybackHandle> {
  const { header, frames: all } = parsed;
  // Frames are sealed under the MEDIA key, not the header key — they are the same bytes the
  // live pipeline decrypted, so they open the same way.
  // Same three inputs the live pipeline used: link secret, the salt in force at the time, and
  // the passcode if one was armed. Any one of them wrong yields a key that opens nothing.
  const mediaKey = await deriveMediaKeyStandalone(secret, {
    streamId: header.streamId,
    salt: header.salt,
    passcode: opts.passcode,
  });

  const nv = all.filter((f) => f.track === TRACK_VIDEO).length;
  const na = all.filter((f) => f.track === TRACK_AUDIO).length;
  console.log(
    `[recording] replay: ${all.length} frames (video=${nv} audio=${na}) ` +
      `videoCfg=${JSON.stringify(header.video)} audioCfg=${JSON.stringify(header.audio)}`
  );

  const ctx = canvas.getContext("2d");
  let stopped = false;
  // Assigned synchronously by the Promise executor, but TS cannot prove that, and a
  // definite-assignment assertion here would be a claim rather than a guarantee.
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  const audioCtx =
    header.audio && typeof AudioContext !== "undefined" ? new AudioContext() : null;
  // A recording is opened by a click, so the context starts unsuspended — unlike the live
  // path, where a rebuilt context has no gesture behind it (see the iOS notes in main.ts).
  await audioCtx?.resume().catch(() => {});

  let videoDec: VideoDecoder | null = null;
  let audioDec: AudioDecoder | null = null;
  let audioAt = 0;

  if (header.video) {
    const cfg = { ...(header.video as VideoDecoderConfig) };
    if (typeof (cfg as { description?: unknown }).description === "string") {
      cfg.description = hexToBytes((cfg as unknown as { description: string }).description);
    }
    videoDec = new VideoDecoder({
      output: (f) => {
        if (!stopped && ctx) {
          if (canvas.width !== f.displayWidth) canvas.width = f.displayWidth;
          if (canvas.height !== f.displayHeight) canvas.height = f.displayHeight;
          ctx.drawImage(f, 0, 0, canvas.width, canvas.height);
        }
        f.close();
      },
      error: (e) => console.error("[recording] video decode:", e),
    });
    try {
      videoDec.configure(cfg);
      console.log("[recording] video decoder configured");
    } catch (e) {
      console.error("[recording] video configure REJECTED:", e, cfg);
    }
  }

  if (header.audio && audioCtx) {
    const cfg = { ...(header.audio as AudioDecoderConfig) };
    if (typeof (cfg as { description?: unknown }).description === "string") {
      cfg.description = hexToBytes((cfg as unknown as { description: string }).description);
    }
    audioDec = new AudioDecoder({
      output: (d) => {
        if (stopped) {
          d.close();
          return;
        }
        const buf = audioCtx.createBuffer(d.numberOfChannels, d.numberOfFrames, d.sampleRate);
        for (let c = 0; c < d.numberOfChannels; c++) {
          const tmp = new Float32Array(d.numberOfFrames);
          d.copyTo(tmp, { planeIndex: c, format: "f32-planar" });
          buf.copyToChannel(tmp, c);
        }
        d.close();
        const src = audioCtx.createBufferSource();
        src.buffer = buf;
        src.connect(audioCtx.destination);
        // Schedule ahead of the clock so consecutive buffers butt up seamlessly rather than
        // each starting "now" and overlapping.
        audioAt = Math.max(audioAt, audioCtx.currentTime);
        src.start(audioAt);
        audioAt += buf.duration;
      },
      error: (e) => console.error("[recording] audio decode:", e),
    });
    try {
      audioDec.configure(cfg);
      console.log("[recording] audio decoder configured");
    } catch (e) {
      console.error("[recording] audio configure REJECTED:", e, cfg);
    }
  }

  (async () => {
    let dropped = 0;
    let fed = 0;
    const t0 = performance.now();
    let base: number | null = null;

    for (const f of all) {
      if (stopped) break;
      let plain: Uint8Array;
      try {
        plain = await decryptFrameWith(mediaKey, f.bytes);
      } catch (e) {
        if (dropped++ === 0) console.warn("[recording] first frame failed to decrypt:", e);
        continue; // a frame we cannot open is a frame we skip, exactly as the live path does
      }
      const { value: ts, len } = readVarint(plain);
      const payload = plain.subarray(len);
      if (base === null) base = ts;

      // Pace to the original timeline.
      const target = (ts - base) / 1000; // varint timestamps are microseconds
      const wait = target - (performance.now() - t0);
      if (wait > 4) await new Promise((r) => setTimeout(r, wait));
      if (stopped) break;

      opts.onProgress?.((ts - base) / 1_000_000);

      try {
        if (f.track === TRACK_VIDEO && videoDec && videoDec.state === "configured") {
          videoDec.decode(
            new EncodedVideoChunk({
              type: f.first ? "key" : "delta",
              timestamp: ts,
              data: payload,
            })
          );
        } else if (f.track === TRACK_AUDIO && audioDec && audioDec.state === "configured") {
          audioDec.decode(new EncodedAudioChunk({ type: "key", timestamp: ts, data: payload }));
        }
        fed++;
      } catch (e) {
        console.warn("[recording] decode rejected a chunk:", e);
      }
    }

    try {
      await videoDec?.flush();
      await audioDec?.flush();
    } catch {
      /* closing mid-flush is normal on stop */
    }
    console.log(`[recording] replay done: fed=${fed} dropped=${dropped}`);
    if (!stopped) opts.onEnd?.();
    resolveDone();
  })();

  return {
    stop() {
      stopped = true;
      try {
        videoDec?.close();
      } catch { /* already closed */ }
      try {
        audioDec?.close();
      } catch { /* already closed */ }
      void audioCtx?.close().catch(() => {});
      resolveDone();
    },
    done,
  };
}

/** `1.2 MB` etc. — recordings are big enough that bytes alone are unreadable. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
