// Video messages — a viewer records a short clip, the broadcaster may put it on screen.
//
// WHAT MOVES, AND WHAT DOES NOT. The clip is sealed in the viewer's browser under a key
// derived from the share link (`deriveMessageKey`), uploaded as opaque bytes, and stored by
// the Worker as a BLOB it has no key for. The broadcaster, who holds the same link, opens it
// locally. So a message has exactly the same property as the broadcast it belongs to: readable
// by link holders, unreadable by us.
//
// HOW "SHOW IT TO EVERYONE" WORKS, and why it needed no code. The broadcaster composites the
// decrypted message into their canvas. The canvas is what gets encoded and encrypted and
// published, so the message reaches every viewer inside the frames they already receive. There
// is no second delivery path, no fan-out, and no new key — see `setMessageVideo` in
// media/pip-compositor.ts.
//
// AUTHORISATION is the route tag, derived from the same link secret that decrypts the video.
// Everyone who can watch can send; nobody else can do either. It is a bearer proof and
// deliberately not an identity: we do not learn WHICH viewer sent a message, and must not.
//
// SIZE. Capped at 10 seconds and 1 MB sealed, enforced here and again in the Worker. The
// recorder is configured down to 480x360 at 500 kbps precisely so a full-length message fits;
// D1 rejects an oversized row with an error a browser cannot act on, so the refusal has to
// happen before the upload starts.

import { deriveMessageKey, openBytes, sealBytes, type DeriveOpts } from "./crypto/media-crypto";

/** Hard ceilings. The Worker enforces the byte cap again; this one is for a useful error. */
export const MAX_MESSAGE_MS = 10_000;
export const MAX_MESSAGE_BYTES = 1_000_000;

export interface MessageMeta {
  id: number;
  bytes: number;
  mime: string;
  created_at: string;
  shown_at: string | null;
}

export interface RecordedMessage {
  blob: Blob;
  /** Object URL for the local preview. The caller revokes it. */
  previewUrl: string;
  durationMs: number;
}

// ---------------------------------------------------------------- recording

/**
 * Record from the viewer's own camera and microphone.
 *
 * Returns a blob plus a preview URL, and does NOT upload — the viewer must see themselves and
 * agree before anything leaves the device. Sending a video of your face to a stranger is not a
 * thing to do by accident, and on a product whose whole premise is that nobody can see you, it
 * is the single biggest change in what a viewer exposes.
 */
export async function recordMessage(opts: {
  /**
   * The live camera stream, handed over the moment it opens so the caller can show a
   * self-view. Recording yourself with no picture is recording blind: you cannot tell if you
   * are in frame, lit, or even pointed at the right camera until it is too late to matter.
   */
  onStream?: (stream: MediaStream) => void;
  onTick?: (msElapsed: number) => void;
  signal?: AbortSignal;
}): Promise<RecordedMessage> {
  const stream = await navigator.mediaDevices.getUserMedia({
    // Small on purpose: the cap is a byte budget, and 480x360 at 500 kbps spends it on ten
    // usable seconds rather than three sharp ones.
    video: { width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: 24 } },
    audio: true,
  });

  opts.onStream?.(stream);
  const stop = () => stream.getTracks().forEach((t) => t.stop());

  // Chrome/Firefox produce WebM; Safari produces MP4. Ask for what the browser actually
  // supports rather than asserting a container and getting an empty blob.
  const mime =
    ["video/webm;codecs=vp8,opus", "video/webm", "video/mp4"].find(
      (m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)
    ) ?? "";

  const rec = new MediaRecorder(stream, {
    ...(mime ? { mimeType: mime } : {}),
    videoBitsPerSecond: 500_000,
    audioBitsPerSecond: 32_000,
  });

  const chunks: BlobPart[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };

  const started = performance.now();
  const done = new Promise<void>((resolve) => {
    rec.onstop = () => resolve();
  });

  rec.start(250);
  const ticker = window.setInterval(() => opts.onTick?.(performance.now() - started), 200);
  const hardStop = window.setTimeout(() => {
    if (rec.state !== "inactive") rec.stop();
  }, MAX_MESSAGE_MS);

  const onAbort = () => {
    if (rec.state !== "inactive") rec.stop();
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  await done;
  window.clearInterval(ticker);
  window.clearTimeout(hardStop);
  opts.signal?.removeEventListener("abort", onAbort);
  stop();

  const blob = new Blob(chunks, { type: rec.mimeType || mime || "video/webm" });
  return {
    blob,
    previewUrl: URL.createObjectURL(blob),
    durationMs: Math.min(performance.now() - started, MAX_MESSAGE_MS),
  };
}

// ---------------------------------------------------------------- transport

const qs = (tag: string) => `?tag=${encodeURIComponent(tag)}`;

/**
 * Seal and upload. Throws with a message fit to show a person — this is the one call in the
 * flow that can fail for a reason the viewer can do something about (too long, queue full).
 */
export async function submitMessage(
  streamId: string,
  routeTag: string,
  secret: string,
  derive: DeriveOpts,
  blob: Blob
): Promise<number> {
  const key = await deriveMessageKey(secret, derive);
  const sealed = await sealBytes(key, new Uint8Array(await blob.arrayBuffer()));
  if (sealed.byteLength > MAX_MESSAGE_BYTES) {
    throw new Error("That message is too large to send. Try a shorter one.");
  }
  const r = await fetch(`/api/streams/${streamId}/messages${qs(routeTag)}`, {
    method: "POST",
    headers: { "content-type": blob.type || "video/webm" },
    body: sealed,
  });
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `Could not send that message (${r.status}).`);
  }
  return ((await r.json()) as { id: number }).id;
}

export async function listMessages(streamId: string, routeTag: string): Promise<MessageMeta[]> {
  const r = await fetch(`/api/streams/${streamId}/messages${qs(routeTag)}`);
  if (!r.ok) return [];
  return ((await r.json()) as { messages: MessageMeta[] }).messages ?? [];
}

/**
 * Fetch one message and open it. Returns null when the key does not fit — the same answer a
 * wrong link gets, and deliberately not distinguishable from a missing message.
 */
export async function openMessage(
  streamId: string,
  routeTag: string,
  secret: string,
  derive: DeriveOpts,
  id: number,
  mime: string
): Promise<Blob | null> {
  const r = await fetch(`/api/streams/${streamId}/messages/${id}${qs(routeTag)}`);
  if (!r.ok) return null;
  const key = await deriveMessageKey(secret, derive);
  const plain = await openBytes(key, new Uint8Array(await r.arrayBuffer()));
  return plain ? new Blob([plain], { type: mime || "video/webm" }) : null;
}

/** Record that a message was put on screen, so the inbox can show what has already aired. */
export async function markShown(streamId: string, routeTag: string, id: number): Promise<void> {
  await fetch(`/api/streams/${streamId}/messages/${id}${qs(routeTag)}`, { method: "POST" }).catch(
    () => {}
  );
}

export async function deleteMessage(streamId: string, routeTag: string, id: number): Promise<void> {
  await fetch(`/api/streams/${streamId}/messages/${id}${qs(routeTag)}`, {
    method: "DELETE",
  }).catch(() => {});
}

/** `0:07` — messages are short enough that minutes:seconds is the only useful form. */
export function formatMs(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}
