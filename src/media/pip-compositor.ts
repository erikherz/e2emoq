// Single A/V compositor for the publisher.
//
// It composites optional camera + screen video onto a FIXED-size <canvas> and mixes
// optional mic + system audio through a WebAudio graph. It exposes ONE stable video
// track (the canvas) and ONE stable audio track (the mix destination) for the whole
// session. Toggling camera/screen/mic changes only the *inputs* — the published track
// identities never change, so viewers never get a RESET_STREAM (and the <moq-watch>
// element, which can't re-subscribe after a track reset, never freezes) when sources
// are added or removed mid-broadcast.
//
// Why a FIXED canvas size: changing a captureStream track's resolution mid-stream forces
// the MoQ video encoder to reconfigure, which republishes the catalog and resets the
// track — exactly the freeze we're avoiding. A constant 1280x720 canvas keeps the encoder
// (and the viewer's subscription) stable; camera/screen content is letterboxed to fit.
//
// DO NOT "fix" portrait capture by resizing this canvas on rotation. Earthseed solves the
// same problem the opposite way — it sizes the encoder to the camera's displayed dimensions
// and reconfigures on portrait<->landscape (earthseed 7503a51) — because it owns its encoder
// and renderer. We publish through <moq-watch>, which cannot re-subscribe after a track
// reset, so adopting that here would trade a cosmetic crop for every viewer freezing each
// time the broadcaster turns their phone.
//
// The orientation half of that fix IS already present here, arrived at independently:
// compositing via ctx.drawImage(video, …) renders the frame as DISPLAYED on every browser,
// including iOS Safari where `new VideoFrame(videoElement)` hands back un-rotated sensor
// pixels. Sizing from videoWidth/videoHeight (post-rotation) rather than getSettings() is
// the other half. So phone capture is upright; only the framing differs.
//
// KNOWN COST, accepted deliberately: drawCover crops a portrait source hard. A 720x1280
// phone scales to 1280x2276 and only the middle ~32% of its vertical field of view survives.
// drawContain would keep the whole frame at the price of pillarbox bars baked into the
// stream. Crop was chosen over bars; revisit that as a product decision, not as a bug fix,
// and note that neither option requires touching the fixed canvas size.
//
// Why a WebAudio mix: swapping the published audio track when crossing camera→screen
// (mic → system audio) would reset the audio track the same way. Instead the mix's output
// track is constant and we connect/disconnect mic and system-audio inputs behind it.

import type { QrMatrix } from "./qr";

const CANVAS_W = 1280;
const CANVAS_H = 720;

/**
 * When the video frame currently on the canvas was captured, for the burn-in.
 *
 * The distinction is the whole point. drawImage() composites the frame the camera exposed some
 * time ago — camera pipeline plus delivery into the page, tens of milliseconds on a laptop and
 * more on a phone — so a timestamp taken at draw time says the picture is newer than it is, by
 * an amount that is the same order as the latency the stamp exists to measure.
 *
 * requestVideoFrameCallback reports the real thing, in the performance.now() timebase, which is
 * exactly the timebase the edge clock is anchored to. So `captureTime` converts to UTC with one
 * addition and no second measurement.
 */
export interface StampFrameInfo {
  /** performance.now()-timebase instant, or null if the browser would not say. */
  captureTime: number | null;
  /**
   * How that instant was obtained, so the caller can be honest about it:
   *   "capture"      — the camera's own capture time. What we want.
   *   "presentation" — when the browser submitted the frame for composition. Later than
   *                    capture by the pipeline delay, so an approximation, not the answer.
   *   "draw"         — nothing available; the caller should fall back to the current time and
   *                    mark the result as approximate.
   */
  source: "capture" | "presentation" | "draw";
}

interface VideoFrameMetadataish {
  captureTime?: number;
  presentationTime?: number;
}

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, md: VideoFrameMetadataish) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

// Subscribe to per-frame metadata for one source. Returns an unsubscribe.
//
// Safe on browsers without rVFC (Firefox at time of writing): the callback simply never fires,
// `set` is never called, and the burn-in falls back to draw time and says so.
function trackFrameTiming(v: HTMLVideoElement, set: (f: StampFrameInfo) => void): () => void {
  const fv = v as FrameCallbackVideo;
  if (typeof fv.requestVideoFrameCallback !== "function") {
    console.warn("[compositor] no requestVideoFrameCallback; burn-in falls back to draw time");
    return () => {};
  }
  let handle = 0;
  let cancelled = false;
  let announced = false;
  const step = (_now: number, md: VideoFrameMetadataish) => {
    if (cancelled) return;
    // captureTime is only populated for sources where the UA knows it (getUserMedia and
    // WebRTC). presentationTime is always there but means something weaker — see above.
    const capture = typeof md?.captureTime === "number" ? md.captureTime : null;
    const presentation = typeof md?.presentationTime === "number" ? md.presentationTime : null;
    const info: StampFrameInfo =
      capture != null
        ? { captureTime: capture, source: "capture" }
        : presentation != null
          ? { captureTime: presentation, source: "presentation" }
          : { captureTime: null, source: "draw" };
    if (!announced) {
      announced = true;
      console.log(`[compositor] frame timing available: ${info.source}`);
    }
    set(info);
    handle = fv.requestVideoFrameCallback!(step);
  };
  handle = fv.requestVideoFrameCallback(step);
  return () => {
    cancelled = true;
    try { fv.cancelVideoFrameCallback?.(handle); } catch { /* not implemented everywhere */ }
  };
}

/** Which way a camera points. The only two values getUserMedia's facingMode agrees on. */
export type CameraFacing = "user" | "environment";

export interface EnableCameraOpts {
  /** Which camera to ask for. Omitted means "whatever this compositor used last". */
  facing?: CameraFacing;
  onEnded?: () => void;
  onMuteChange?: (muted: boolean) => void;
}

export interface Compositor {
  readonly videoTrack: MediaStreamTrack; // stable: the canvas composite
  readonly audioTrack: MediaStreamTrack; // stable: the WebAudio mix destination
  readonly canvas: HTMLCanvasElement; // publisher preview; drag the camera inset to move it
  hasCamera: () => boolean;
  hasScreen: () => boolean;
  /**
   * Start the camera.
   *
   * `onEnded` fires when the SOURCE goes away by itself — the OS handing the camera to
   * another app, a USB camera unplugged, a driver reset. Windows does this routinely, and it
   * is not otherwise detectable: the track just stops, the video element's dimensions drop to
   * zero, and drawCover then paints nothing over the black background. So the composite turns
   * into a black rectangle while the Camera button is still lit — see scripts/e2e/camera-yanked.mjs.
   *
   * `onMuteChange(true)` fires when frames stop arriving from a track that is still live,
   * which is the other half of the same Windows behaviour. The last frame stays on the canvas
   * (a freeze rather than a blackout), so this is a warning, not a teardown.
   */
  enableCamera: (opts?: EnableCameraOpts) => Promise<void>;
  disableCamera: () => void;
  /** Which camera is live, or null when the camera is off. */
  cameraFacing: () => CameraFacing | null;
  /**
   * Swap front camera for back, or back for front. Resolves to the facing that is actually
   * live afterwards — which is not necessarily the one requested, so callers should label the
   * control from the return value rather than from what they asked for.
   *
   * Resolves to null only when the camera could not be brought back at all; `onEnded` from the
   * original enableCamera fires in that case, because a broadcaster must never be left with a
   * lit Camera button over a black rectangle.
   */
  switchCamera: () => Promise<CameraFacing | null>;
  enableScreen: (opts?: { onEnded?: () => void }) => Promise<void>;
  disableScreen: () => void;
  /**
   * Burn a line of text across the bottom of every composited frame, or null to stop.
   * Called once per drawn frame with when that frame's picture was captured, so the caller
   * can stamp the moment of capture rather than the moment of drawing.
   */
  setStampProvider: (fn: ((frame: StampFrameInfo) => string) | null) => void;
  /**
   * A broadcaster's handle, drawn as a subtle watermark in the upper left, or null for none.
   * Static text, unlike the burn-in, so it is set rather than polled per frame.
   */
  setWatermark: (text: string | null) => void;
  /**
   * A QR code drawn on an opaque plate in the upper right, or null to remove it.
   *
   * Takes an already-encoded matrix rather than a URL: encoding is the caller's job, because
   * the caller is the one that has to tell a broadcaster when a URL will not fit at a
   * scannable size. By the time it reaches here the decision is made.
   */
  setLinkQr: (matrix: QrMatrix | null) => void;
  setMicEnabled: (on: boolean) => Promise<void>;
  setSystemAudioEnabled: (on: boolean) => void;
  stop: () => void;
}

function mkVideo(stream: MediaStream): HTMLVideoElement {
  const v = document.createElement("video");
  v.srcObject = stream;
  v.muted = true;
  v.playsInline = true;
  void v.play().catch(() => {});
  return v;
}

export function createCompositor(): Compositor {
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");

  // ---- Video sources (added/removed on demand) ----
  let screen: { stream: MediaStream; video: HTMLVideoElement } | null = null;
  let camera: { stream: MediaStream; video: HTMLVideoElement } | null = null;

  // Per-frame capture timing for each source, kept current by requestVideoFrameCallback.
  //
  // The read in draw() is race-free by spec: video frame callbacks run BEFORE animation frame
  // callbacks within the same rendering opportunity, so by the time draw() executes, these
  // describe the very frame drawImage() is about to composite.
  const NO_FRAME_TIMING: StampFrameInfo = { captureTime: null, source: "draw" };
  let cameraFrame: StampFrameInfo | null = null;
  let screenFrame: StampFrameInfo | null = null;
  let untrackCamera: (() => void) | null = null;
  // Remembered across an off/on cycle so a broadcaster who chose the back camera does not
  // silently get the front one back when they toggle Camera off and on again.
  let facing: CameraFacing = "user";
  let facingLive = false;
  // The handlers the caller registered. switchCamera tears the camera down and builds it
  // again, and those listeners have to survive that or the second camera loses its
  // taken-away-by-the-OS detection.
  let cameraOpts: EnableCameraOpts | null = null;
  let untrackScreen: (() => void) | null = null;

  // Letterbox a video into the whole canvas, preserving aspect ratio (fits inside, may
  // leave black bars). Used for screen shares, where cropping would hide content.
  const drawContain = (v: HTMLVideoElement) => {
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    if (!vw || !vh) return;
    const scale = Math.min(CANVAS_W / vw, CANVAS_H / vh);
    const w = vw * scale;
    const h = vh * scale;
    ctx.drawImage(v, (CANVAS_W - w) / 2, (CANVAS_H - h) / 2, w, h);
  };

  // Fill the whole canvas with a video, preserving aspect ratio and cropping the overflow
  // (the inverse of drawContain). Used for a single full-frame camera so a portrait phone
  // source fills the frame instead of pillarboxing — no baked-in black bars in the stream.
  const drawCover = (v: HTMLVideoElement) => {
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    if (!vw || !vh) return;
    const scale = Math.max(CANVAS_W / vw, CANVAS_H / vh);
    const w = vw * scale;
    const h = vh * scale;
    ctx.drawImage(v, (CANVAS_W - w) / 2, (CANVAS_H - h) / 2, w, h);
  };

  // Camera inset (only when screen + camera): drag the middle to move it, drag an edge or a
  // corner to resize. Default ~28% of frame width, bottom-right.
  //
  // Resizing changes ONLY this rect. The canvas stays 1280x720 — see the header: a captureStream
  // resolution change mid-broadcast reconfigures the encoder, republishes the catalog and resets
  // the track, which freezes every viewer. The inset is composited content, so it can be any
  // size at any moment and no viewer notices anything but the picture moving.
  const MIN_SCALE = 0.1;
  const MAX_SCALE = 0.75;
  let insetScale = 0.28;
  let px = 0;
  let py = 0;
  let placed = false;
  const camAspect = () => {
    const cw = camera?.video.videoWidth || 16;
    const ch = camera?.video.videoHeight || 9;
    return cw / ch;
  };
  const insetW = () => Math.round(CANVAS_W * insetScale);
  const insetH = () => Math.round(insetW() / camAspect());
  // The HEIGHT limit is what bites first on a portrait camera: at 3:4 a 75%-wide inset would be
  // 1280 tall on a 720 canvas. Cap by whichever constraint is tighter.
  const clampScale = (v: number) =>
    Math.max(MIN_SCALE, Math.min(v, MAX_SCALE, (CANVAS_H / CANVAS_W) * camAspect()));

  // Which part of the inset the pointer is over. Corners take priority over edges, and the
  // interior means "move" — the behaviour this had before resizing existed.
  type Zone = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "move";
  const HANDLE_ZONES: Zone[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  // In canvas units. The canvas is displayed at up to 900px for a 1280 backing store, so 20
  // here is ~14 real pixels — comfortably grabbable with a mouse without the edge band eating
  // a small inset's whole interior.
  const HANDLE = 20;
  const CURSOR: Record<Zone, string> = {
    nw: "nwse-resize", se: "nwse-resize",
    ne: "nesw-resize", sw: "nesw-resize",
    n: "ns-resize", s: "ns-resize",
    e: "ew-resize", w: "ew-resize",
    move: "grab",
  };

  // Hit-test an arbitrary rect, so the camera inset and the QR plate below share one set of
  // rules rather than growing two subtly different ones.
  const zoneIn = (
    pt: { x: number; y: number }, x: number, y: number, w: number, h: number,
  ): Zone | null => {
    if (pt.x < x - HANDLE || pt.x > x + w + HANDLE) return null;
    if (pt.y < y - HANDLE || pt.y > y + h + HANDLE) return null;
    const l = Math.abs(pt.x - x) <= HANDLE;
    const r = Math.abs(pt.x - (x + w)) <= HANDLE;
    const t = Math.abs(pt.y - y) <= HANDLE;
    const b = Math.abs(pt.y - (y + h)) <= HANDLE;
    if (t && l) return "nw";
    if (t && r) return "ne";
    if (b && l) return "sw";
    if (b && r) return "se";
    if (t) return "n";
    if (b) return "s";
    if (l) return "w";
    if (r) return "e";
    return pt.x >= x && pt.x <= x + w && pt.y >= y && pt.y <= y + h ? "move" : null;
  };

  const zoneAt = (pt: { x: number; y: number }): Zone | null =>
    screen && camera ? zoneIn(pt, px, py, insetW(), insetH()) : null;

  // ---- Burn-in strip (location + time), drawn last so nothing can cover it ----
  //
  // Drawn INTO the composite, not overlaid in the DOM, which is the whole point: it becomes
  // picture, so it survives recording, re-encoding and screenshots, and it travels inside the
  // E2E media encryption like every other pixel — only holders of the link and passcode see
  // it. Cost to be aware of: the millisecond field changes every frame, so this strip is
  // permanently "moving" and never inter-predicts away. It is a small fraction of a 1280x720
  // frame, but it is not free at a low bitrate cap.
  const STAMP_H = 40;
  let stampProvider: ((frame: StampFrameInfo) => string) | null = null;
  const drawStamp = (frame: StampFrameInfo) => {
    if (!stampProvider) return;
    let text = "";
    try {
      text = stampProvider(frame);
    } catch {
      return; // a throwing provider must not take down the whole draw loop
    }
    if (!text) return;
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.62)";
    ctx.fillRect(0, CANVAS_H - STAMP_H, CANVAS_W, STAMP_H);
    // Monospace so the digits don't shimmy as the milliseconds turn over.
    ctx.font = '600 22px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";
    // maxWidth squeezes rather than overflows if a future line grows.
    ctx.fillText(text, CANVAS_W / 2, CANVAS_H - STAMP_H / 2 + 1, CANVAS_W - 32);
    ctx.restore();
  };

  // ---- Handle watermark (upper left) ----
  //
  // Subtle on purpose: semi-transparent white with a soft dark shadow, no plate behind it. The
  // shadow is what keeps it legible over a white slide as well as a dark room — without it,
  // "subtle" becomes "invisible" on half the content people actually broadcast.
  //
  // Like the burn-in, this is drawn into the composite rather than overlaid in the DOM, so it
  // is part of the encoded picture and travels inside the E2E encryption. Unlike the burn-in,
  // it is static text, so it costs the encoder nothing after the first frame.
  let watermark: string | null = null;
  const drawWatermark = () => {
    if (!watermark) return;
    ctx.save();
    ctx.font = '600 26px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.shadowColor = "rgba(0,0,0,0.65)";
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = "rgba(255,255,255,0.62)";
    ctx.fillText(watermark, 28, 24, CANVAS_W * 0.6);
    ctx.restore();
  };

  // ---- Link QR (upper right) ----
  //
  // A URL the broadcaster wants their audience to reach, drawn as a QR so a phone pointed at
  // the screen can take them there. Like the handle and the burn-in it lives in the composited
  // picture, so it survives a screen recording and stays inside the E2E encryption.
  //
  // THIS ONE CANNOT BE SUBTLE, AND THAT IS THE WHOLE DESIGN CONSTRAINT.
  //
  // The handle above is drawn at 62% white with no plate because it only has to be readable by
  // a person, who will forgive low contrast. A QR has to be readable by a camera through a
  // video codec, and both of those punish exactly what makes a watermark tasteful:
  //
  //  - Transparency is out, but not for the reason it looks like — see QR_LIGHT below, where
  //    it was measured against the alternative and lost on both axes at once.
  //  - Small is out. Below roughly four canvas pixels per module, inter-frame compression
  //    smears adjacent modules together and the symbol dies — so module size, not plate size,
  //    is what gets held fixed here.
  //  - The quiet zone is not optional. The standard requires four light modules of margin;
  //    without it a scanner cannot find the symbol's edge at all.
  //
  // Rendered once to an offscreen canvas when the URL is set, then blitted per frame. Drawing
  // ~1,700 fillRects sixty times a second would be absurd for a picture that never changes.
  // These four are MEASURED, not chosen. The test that produced them renders a symbol at this
  // exact geometry over textured content, scales the frame down the way a viewer's window
  // does, JPEG-compresses it as a stand-in for a bitrate-starved encoder, and then tries to
  // decode the result with OpenCV.
  //
  // The first attempt was a 176px target with a 4px floor. It decoded perfectly at full canvas
  // resolution and fell apart as soon as the frame was scaled — which is the ordinary case,
  // not an edge one, since almost nobody watches a 1280-wide video at exactly 1280 pixels.
  // At 232/6 everything tested decodes at full and three-quarter scale.
  //
  // Below half scale it stays patchy, and that is worth stating plainly rather than tuning
  // until a number looks good: the results there are erratic in a way that tracks resampling
  // artefacts rather than symbol size, and a real phone scanner — many frames, autofocus,
  // pointed at a physical screen rather than at a downscaled buffer — is a much better
  // detector than this test's. So these are a floor on quality, not a guarantee of a scan.
  const QR_MODULE_TARGET_PX = 232; // default plate side before rounding to whole modules
  const QR_MAX_PLATE_PX = 460;     // past ~64% of frame height it stops being a video with a QR on it
  const QR_MODULE_MIN_PX = 6;      // below this the symbol stops surviving being scaled
  const QR_QUIET = 4;              // light modules of margin, per the standard
  const QR_MARGIN = 24;            // inset from the top and right edges, matching the handle

  // The plate's two tones. NOT pure white and black, and not transparent either — this is the
  // one setting here that went through a wrong answer first, so the reasoning is worth keeping.
  //
  // The obvious way to make a watermark less obtrusive is to make it see-through, the way the
  // handle above is. Measured, that is the WORSE of the two available levers, on both axes at
  // once. Alpha lets background texture into the quiet zone, and the quiet zone is what a
  // scanner uses to find the symbol's edge — so transparency starts failing over busy content
  // at around 0.70, while only reaching a plate brightness of ~192/255. Anything gentle enough
  // to notice was already too damaged to scan.
  //
  // Muting the palette instead keeps the plate perfectly uniform, so the quiet zone stays
  // clean and the local contrast a decoder needs is untouched — both tones simply move down
  // together. 170/40 reads at 170/255 against a dim room, softer than transparency ever
  // managed, and decoded 8/8 across dark, light and busy backgrounds through the full
  // degradation. Strictly better, which is not the trade-off it looked like from the outside.
  //
  // Going darker still (120/20) starts costing decodes over a white slide. Same caveats as
  // the sizing constants: one detector, synthetic backgrounds, re-measure before changing.
  const QR_LIGHT = "#aaaaaa"; // 170 — the plate and its quiet zone
  const QR_DARK = "#282828";  // 40  — the modules

  let qrPlate: HTMLCanvasElement | null = null;
  // Kept so a resize can re-render from the same symbol without asking the caller to encode
  // again — the caller's job is deciding whether a URL fits at all, and that answer does not
  // change when the broadcaster drags a corner.
  let qrMatrix: QrMatrix | null = null;

  // Move/resize state, mirroring the camera inset above. The QR differs in one way that
  // matters: its lower bound is not aesthetic. Below QR_MODULE_MIN_PX per module the symbol
  // stops surviving being scaled, so shrinking past that does not produce a small QR — it
  // produces a decoration no phone can read. The clamp is therefore on the MODULE size, and
  // for a link long enough to carry a key the default plate already sits on that floor, so
  // such a code can be moved and enlarged but not shrunk. That is a real limit of the format,
  // not a missing feature, and it is better felt as a hard stop than discovered by a viewer
  // whose camera will not lock on.
  let qrTargetPx = QR_MODULE_TARGET_PX;
  let qrX = 0;
  let qrY = 0;
  let qrPlaced = false;

  // Keep the whole plate on the canvas. A half-cropped QR is not merely untidy: the quiet
  // zone is what a scanner uses to find the symbol's edge, so a clipped one stops being
  // findable at all.
  const clampQr = () => {
    if (!qrPlate) return;
    qrX = Math.max(0, Math.min(qrX, CANVAS_W - qrPlate.width));
    qrY = Math.max(0, Math.min(qrY, CANVAS_H - qrPlate.height));
  };

  const qrZoneAt = (pt: { x: number; y: number }): Zone | null =>
    qrPlate ? zoneIn(pt, qrX, qrY, qrPlate.width, qrPlate.height) : null;

  const renderQrPlate = (matrix: QrMatrix | null) => {
    qrMatrix = matrix;
    if (!matrix) {
      qrPlate = null;
      return;
    }
    const total = matrix.size + QR_QUIET * 2;
    // Whole pixels per module, never fractional: a module that lands on a half-pixel gets
    // anti-aliased into grey, which is the one colour a scanner cannot classify. This is why
    // the plate size varies a little with URL length instead of the module size doing so.
    // Whole pixels per module at EVERY size, which is why resizing re-renders the plate
    // rather than scaling the bitmap: drawImage at a fractional scale anti-aliases modules
    // into grey, the one tone a decoder cannot classify. The visible consequence is that a
    // corner drag steps between scannable sizes instead of sliding smoothly, and that is the
    // honest behaviour — every size it stops at is one that actually scans.
    const px = Math.max(QR_MODULE_MIN_PX, Math.floor(qrTargetPx / total));
    const side = total * px;

    const plate = document.createElement("canvas");
    plate.width = side;
    plate.height = side;
    const pctx = plate.getContext("2d");
    if (!pctx) return;
    pctx.fillStyle = QR_LIGHT;
    pctx.fillRect(0, 0, side, side);
    pctx.fillStyle = QR_DARK;
    for (let y = 0; y < matrix.size; y++) {
      for (let x = 0; x < matrix.size; x++) {
        if (matrix.get(x, y)) {
          pctx.fillRect((x + QR_QUIET) * px, (y + QR_QUIET) * px, px, px);
        }
      }
    }
    qrPlate = plate;
    if (!qrPlaced) {
      // First appearance keeps the original home, inset from the top and right edges. After
      // that the broadcaster's own placement survives a URL change, which is the point.
      qrX = CANVAS_W - side - QR_MARGIN;
      qrY = QR_MARGIN;
      qrPlaced = true;
    }
    clampQr();
  };

  const drawLinkQr = () => {
    if (!qrPlate) return;
    ctx.save();
    // A soft shadow separates the plate from similarly-toned content behind it. It falls
    // outside the plate, so it never touches a module or the quiet zone. Drawn OPAQUE — see
    // QR_LIGHT for why transparency was measured and rejected.
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 12;
    ctx.drawImage(qrPlate, qrX, qrY);
    ctx.restore();
  };

  let raf = 0;
  // The draw loop is scheduled two different ways, and which one is running depends on whether
  // anybody can see this tab.
  //
  // requestAnimationFrame does not fire in a hidden tab, and canvas.captureStream() only
  // produces a frame when the canvas is painted. So a broadcaster who switched to another tab —
  // to open their own share link, say — stopped sending pictures, and everyone watching froze on
  // the last frame. Nothing errored: the publisher stayed connected, the status light stayed
  // green, audio kept flowing (WebAudio is not rAF-driven), and only the picture stopped. That
  // is why it was reported as "it froze" rather than as anything to do with tabs.
  //
  // Measured on this page 2026-08-29: rAF 60/s visible, 0/s hidden. setInterval 30/s in BOTH,
  // because a page holding a live getUserMedia capture is exempt from Chrome's intensive
  // background timer throttling. So the timer is a real fallback here, not a 1fps token one.
  //
  // rAF stays the path whenever the tab is visible: it is vsync-aligned, and it costs nothing
  // when the compositor would be idle anyway.
  // Declared up here, not beside stop(), because startLoop() below reads it and now runs during
  // this factory's own body. Left further down it was a temporal-dead-zone crash on every
  // broadcast — caught by `vite preview` before it shipped.
  let stopped = false;
  const HIDDEN_FRAME_MS = 1000 / 30;
  let timer: ReturnType<typeof setInterval> | null = null;
  const draw = () => {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    if (screen) {
      drawContain(screen.video);
      if (camera) {
        const w = insetW();
        const h = insetH();
        if (!placed && w && h) {
          px = CANVAS_W - w - 24;
          py = CANVAS_H - h - 24;
          placed = true;
        }
        px = Math.max(0, Math.min(px, CANVAS_W - w));
        py = Math.max(0, Math.min(py, CANVAS_H - h));
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,0.5)";
        ctx.shadowBlur = 14;
        ctx.drawImage(camera.video, px, py, w, h);
        ctx.restore();
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.lineWidth = 2;
        ctx.strokeRect(px, py, w, h);
      }
    } else if (camera) {
      // Camera-only: fill the frame (crop) rather than letterbox, so a portrait phone
      // camera doesn't produce black pillarbox bars in the published stream.
      drawCover(camera.video);
    }
    // Stamp the CAMERA's capture time when a camera is on, even while it is the small inset
    // over a screen share: the camera is the source that witnesses the physical world, which
    // is what a provenance stamp is about. Screen-only stamps the screen grab. Neither
    // present (audio-only, or before the first frame) falls through to "draw".
    drawWatermark();
    drawLinkQr();
    drawStamp((camera ? cameraFrame : screen ? screenFrame : null) ?? NO_FRAME_TIMING);
    // Keep the DOM chrome on top of the inset it describes. Defined below; by the time any
    // rAF callback runs, the whole factory body has finished executing.
    syncChrome();
  };

  const stopLoop = () => {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  // One frame, and never a thrown one.
  //
  // The re-schedule used to be the last statement of draw(), so ANY exception anywhere in it
  // silently ended the broadcast for good — the canvas kept its last picture and went on being
  // published. Nothing in draw() is expected to throw, which is exactly why it must not be able
  // to take the loop with it if it ever does.
  let drawFailed = false;
  const paint = () => {
    try {
      draw();
    } catch (e) {
      // Once, not sixty times a second. A loop that fails every frame would otherwise bury the
      // first and most useful report under thousands of copies of itself.
      if (!drawFailed) {
        drawFailed = true;
        console.error("[compositor] draw failed; the loop continues", e);
      }
    }
  };

  const startLoop = () => {
    stopLoop();
    if (stopped) return;
    if (document.hidden) timer = setInterval(paint, HIDDEN_FRAME_MS);
    else {
      const tick = () => {
        paint();
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }
  };

  const onVisibility = () => startLoop();
  document.addEventListener("visibilitychange", onVisibility);
  startLoop();

  // Move and resize the camera inset (only meaningful when both screen + camera are on).
  type Target = "cam" | "qr";
  let mode: Zone | null = null;      // what the pointer grabbed, null when idle
  let target: Target | null = null;  // WHICH object it grabbed
  let hover: Zone | null = null;     // what it is merely over, for the chrome and the cursor
  let hoverTarget: Target | null = null;
  let dx = 0;
  let dy = 0;
  let anchorX = 0; // the corner held FIXED while resizing: the box grows away from the hand
  let anchorY = 0;
  const toCanvas = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (CANVAS_W / r.width),
      y: (e.clientY - r.top) * (CANVAS_H / r.height),
    };
  };
  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", (e) => {
    const p = toCanvas(e);
    // The QR is drawn over the inset, so where they overlap it wins the pointer — grabbing
    // what is visibly on top is the only behaviour that is not a surprise.
    const qz = qrZoneAt(p);
    const z = qz ?? zoneAt(p);
    if (!z) return;
    target = qz ? "qr" : "cam";
    mode = z;
    hover = z;
    hoverTarget = target;
    const ox = target === "qr" ? qrX : px;
    const oy = target === "qr" ? qrY : py;
    const ow = target === "qr" ? qrPlate?.width ?? 0 : insetW();
    const oh = target === "qr" ? qrPlate?.height ?? 0 : insetH();
    if (z === "move") {
      dx = p.x - ox;
      dy = p.y - oy;
      canvas.style.cursor = "grabbing";
    } else {
      // Anchor the OPPOSITE edge/corner. Dragging the north-west handle keeps the south-east
      // corner planted, which is what every image editor does and what the hand expects.
      anchorX = z.includes("w") ? ox + ow : ox;
      anchorY = z.includes("n") ? oy + oh : oy;
    }
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = toCanvas(e);
    if (!mode) {
      const qz = qrZoneAt(p);
      hover = qz ?? zoneAt(p);
      hoverTarget = hover ? (qz ? "qr" : "cam") : null;
      canvas.style.cursor = hover ? CURSOR[hover] : "";
      return;
    }
    if (target === "qr") {
      if (mode === "move") {
        qrX = p.x - dx;
        qrY = p.y - dy;
        clampQr();
        return;
      }
      // The plate is square, so one axis is enough and a corner follows the bolder of the
      // two. Re-render rather than scale — see renderQrPlate for why that is not optional.
      const fx = mode.includes("w") ? anchorX - p.x : p.x - anchorX;
      const fy = mode.includes("n") ? anchorY - p.y : p.y - anchorY;
      let side: number;
      if (mode === "n" || mode === "s") side = fy;
      else if (mode === "e" || mode === "w") side = fx;
      else side = Math.max(fx, fy);
      qrTargetPx = Math.max(0, Math.min(side, QR_MAX_PLATE_PX));
      renderQrPlate(qrMatrix);
      if (qrPlate) {
        // Re-derive the origin from the anchor so the held corner does not creep as the
        // module size quantises underneath it.
        qrX = mode.includes("w") ? anchorX - qrPlate.width : anchorX;
        qrY = mode.includes("n") ? anchorY - qrPlate.height : anchorY;
        clampQr();
      }
      return;
    }
    if (mode === "move") {
      px = p.x - dx;
      py = p.y - dy;
      return;
    }
    // ASPECT IS LOCKED — "resize at scale". One axis drives and the other follows, so the
    // camera is never stretched and the published inset always matches the sensor's shape.
    const a = camAspect();
    const fromX = mode.includes("w") ? anchorX - p.x : p.x - anchorX;
    const fromY = mode.includes("n") ? anchorY - p.y : p.y - anchorY;
    let want: number;
    if (mode === "n" || mode === "s") want = fromY * a;      // vertical edge: height drives
    else if (mode === "e" || mode === "w") want = fromX;     // horizontal edge: width drives
    else want = Math.max(fromX, fromY * a);                  // corner: follow the bolder axis
    insetScale = clampScale(want / CANVAS_W);
    // Re-derive the origin from the anchor so the held corner does not creep as we clamp.
    px = mode.includes("w") ? anchorX - insetW() : anchorX;
    py = mode.includes("n") ? anchorY - insetH() : anchorY;
  });
  const endDrag = (e: PointerEvent) => {
    mode = null;
    target = null;
    const p = toCanvas(e);
    const qz = qrZoneAt(p);
    hover = qz ?? zoneAt(p);
    hoverTarget = hover ? (qz ? "qr" : "cam") : null;
    canvas.style.cursor = hover ? CURSOR[hover] : "";
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("pointerleave", () => {
    if (mode) return; // a capture is in progress; leaving the box is normal mid-drag
    hover = null;
    hoverTarget = null;
    canvas.style.cursor = "";
  });

  // ---- Move/resize chrome, drawn in the DOM and deliberately NOT into the canvas ----
  //
  // The canvas IS the published video, so every pixel ctx draws reaches every viewer. The thin
  // white outline around the inset is drawn in because it is framing — it belongs in the
  // picture. Hover handles do not: they would blink into the broadcast each time the publisher
  // moved their mouse, showing the audience an interface they cannot use.
  //
  // So the interactive chrome is a plain <div> positioned over the canvas, tracking the same
  // rect in CSS pixels. It costs nothing in the encoder and no viewer can ever see it.
  type Chrome = { el: HTMLDivElement | null; key: string };
  const camChrome: Chrome = { el: null, key: "" };
  const qrChrome: Chrome = { el: null, key: "" };

  const ensureChrome = (c: Chrome): HTMLDivElement | null => {
    if (c.el) return c.el;
    const parent = canvas.parentElement;
    if (!parent) return null; // not mounted yet; try again next frame
    if (!parent.style.position) parent.style.position = "relative";
    const el = document.createElement("div");
    // pointer-events:none throughout — the canvas owns all the hit testing, and a handle that
    // swallowed the pointer would break the drag it is supposed to advertise.
    el.style.cssText =
      "position:absolute;pointer-events:none;display:none;box-sizing:border-box;z-index:5;" +
      "border:2px solid rgba(96,165,250,0.95);border-radius:4px;" +
      "box-shadow:0 0 0 1px rgba(0,0,0,0.45),0 0 12px rgba(59,130,246,0.35);";
    for (const z of HANDLE_ZONES) {
      const h = document.createElement("div");
      const vert = z.includes("n") ? "top:-6px;" : z.includes("s") ? "bottom:-6px;" : "top:calc(50% - 5px);";
      const horz = z.includes("w") ? "left:-6px;" : z.includes("e") ? "right:-6px;" : "left:calc(50% - 5px);";
      h.style.cssText =
        "position:absolute;width:10px;height:10px;box-sizing:border-box;background:#fff;" +
        "border:1px solid rgba(30,64,175,0.9);border-radius:2px;" + vert + horz;
      el.appendChild(h);
    }
    parent.appendChild(el);
    c.el = el;
    return el;
  };

  // Called once per drawn frame, but only WRITES when the rect actually changed — otherwise
  // this would touch layout 60 times a second for a box that is usually sitting still.
  const syncOne = (c: Chrome, wanted: boolean, x: number, y: number, w: number, h: number) => {
    const el = wanted ? ensureChrome(c) : c.el;
    if (!el) return;
    if (!wanted) {
      if (el.style.display !== "none") el.style.display = "none";
      c.key = "";
      return;
    }
    const shown = canvas.clientWidth;
    if (!shown) return; // laid out at zero width (hidden tab); nothing sensible to draw
    const scale = shown / CANVAS_W;
    const key = `${Math.round(x)}|${Math.round(y)}|${Math.round(w)}|${Math.round(h)}|${scale.toFixed(4)}|${canvas.offsetLeft}|${canvas.offsetTop}`;
    if (key === c.key) return;
    c.key = key;
    el.style.display = "block";
    el.style.left = `${canvas.offsetLeft + x * scale}px`;
    el.style.top = `${canvas.offsetTop + y * scale}px`;
    el.style.width = `${w * scale}px`;
    el.style.height = `${h * scale}px`;
  };

  // Only ever ONE outline at a time: the object under the hand, or the one being dragged.
  // Showing both would advertise handles the pointer is not going to reach, since the QR
  // takes the pointer wherever the two overlap.
  const syncChrome = () => {
    const active = mode !== null ? target : hoverTarget;
    syncOne(camChrome, !!(screen && camera) && active === "cam", px, py, insetW(), insetH());
    syncOne(qrChrome, !!qrPlate && active === "qr", qrX, qrY, qrPlate?.width ?? 0, qrPlate?.height ?? 0);
  };

  // ---- Audio mix: one stable output track; mic + system audio are inputs ----
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ac = new AC();
  const dest = ac.createMediaStreamDestination();

  // Autoplay policy (esp. Safari): an AudioContext can start/stay "suspended", and a
  // suspended context's MediaStreamDestination publishes SILENCE — which is exactly the
  // "audio-only works, but no audio once video is added" symptom (the composite mix runs
  // through this context; native audio-only capture doesn't). We resume on the next user
  // gesture (a guaranteed activation, unlike a resume() called after an await), and detach
  // the listener once running.
  const onGesture = () => {
    ac.resume().then(() => {
      if (ac.state === "running") document.removeEventListener("pointerdown", onGesture);
    }).catch(() => { /* retry on the next gesture */ });
  };
  document.addEventListener("pointerdown", onGesture);
  let micStream: MediaStream | null = null;
  let micNode: MediaStreamAudioSourceNode | null = null;
  let sysNode: MediaStreamAudioSourceNode | null = null;

  // ---- Stable published tracks (identity never changes for the session) ----
  const composite = canvas.captureStream(30);
  const videoTrack = composite.getVideoTracks()[0];
  const audioTrack = dest.stream.getAudioTracks()[0];


  return {
    videoTrack,
    audioTrack,
    canvas,
    hasCamera: () => !!camera,
    hasScreen: () => !!screen,

    async enableCamera(opts) {
      if (camera || stopped) return;
      cameraOpts = opts ?? cameraOpts;
      const want = opts?.facing ?? facing;
      // `ideal`, not `exact`. A laptop with one camera satisfies an ideal constraint by
      // handing back the camera it has; `exact` would throw OverconstrainedError and turn a
      // harmless preference into a failure to start at all.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: want } },
        audio: false,
      });
      camera = { stream, video: mkVideo(new MediaStream(stream.getVideoTracks())) };
      // What we ASKED for and what we GOT are different questions, and only the second one
      // should reach a label. Chrome on a desktop reports no facingMode at all, so an absent
      // value means "unknown" and the request stands in for it.
      const got = stream.getVideoTracks()[0]?.getSettings().facingMode;
      facing = got === "user" || got === "environment" ? got : want;
      facingLive = true;
      untrackCamera = trackFrameTiming(camera.video, (f) => { cameraFrame = f; });
      placed = false; // re-place the inset for the new camera aspect ratio
      // The camera can be taken away without the page doing anything — the screen share has
      // always handled that (below) and the camera never did. Same treatment.
      const track = stream.getVideoTracks()[0];
      track?.addEventListener("ended", () => {
        this.disableCamera();
        opts?.onEnded?.();
      });
      track?.addEventListener("mute", () => opts?.onMuteChange?.(true));
      track?.addEventListener("unmute", () => opts?.onMuteChange?.(false));
    },
    disableCamera() {
      untrackCamera?.();
      untrackCamera = null;
      cameraFrame = null; // never stamp a live frame with a dead source's capture time
      camera?.stream.getTracks().forEach((t) => t.stop());
      if (camera) camera.video.srcObject = null;
      camera = null;
      facingLive = false;
    },

    cameraFacing: () => (facingLive ? facing : null),

    async switchCamera() {
      if (!camera || stopped) return null;
      const from = facing;
      const want: CameraFacing = from === "environment" ? "user" : "environment";
      const opts = cameraOpts ?? undefined;

      // The old camera must be released BEFORE the new one is requested. iOS will not hand
      // out a second camera while one is live, and the failure is not a clean rejection —
      // the first track goes mute and the page is left showing a frozen picture.
      this.disableCamera();
      try {
        await this.enableCamera({ ...opts, facing: want });
        return facing;
      } catch {
        // Put back what was working a moment ago. Nothing else can: the old track is stopped
        // and a stopped track cannot be restarted.
        try {
          await this.enableCamera({ ...opts, facing: from });
          return facing;
        } catch {
          // Both failed, so the camera is genuinely gone — another app took it during the
          // gap, most likely. Say so through the same channel as any other camera loss.
          opts?.onEnded?.();
          return null;
        }
      }
    },

    async enableScreen(opts) {
      if (screen || stopped) return;
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      screen = { stream, video: mkVideo(new MediaStream(stream.getVideoTracks())) };
      untrackScreen = trackFrameTiming(screen.video, (f) => { screenFrame = f; });
      placed = false;
      // If the user ends the share via the browser's own UI, tear it down + notify.
      stream.getVideoTracks()[0].addEventListener("ended", () => {
        this.disableScreen();
        opts?.onEnded?.();
      });
    },
    disableScreen() {
      this.setSystemAudioEnabled(false);
      untrackScreen?.();
      untrackScreen = null;
      screenFrame = null;
      screen?.stream.getTracks().forEach((t) => t.stop());
      if (screen) screen.video.srcObject = null;
      screen = null;
      placed = false;
    },

    setStampProvider(fn) {
      stampProvider = stopped ? null : fn;
    },

    setWatermark(text) {
      watermark = stopped ? null : text;
    },

    setLinkQr(matrix) {
      renderQrPlate(stopped ? null : matrix);
    },

    async setMicEnabled(on) {
      if (stopped) return;
      if (on && !micStream) {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        micNode = ac.createMediaStreamSource(micStream);
        micNode.connect(dest);
        // Resume AFTER wiring the graph; await it so we don't bind a silent (suspended)
        // destination track. If it's still not running, the pointerdown fallback recovers it.
        await ac.resume().catch(() => {});
        if (ac.state !== "running") {
          console.warn(`[compositor] AudioContext is ${ac.state}; audio stays silent until a click/tap on the page resumes it`);
        }
      } else if (!on && micStream) {
        try { micNode?.disconnect(); } catch { /* ignore */ }
        micStream.getTracks().forEach((t) => t.stop());
        micNode = null;
        micStream = null;
      }
    },
    setSystemAudioEnabled(on) {
      if (stopped) return;
      const sysTrack = screen?.stream.getAudioTracks()[0] ?? null;
      if (on && sysTrack && !sysNode) {
        void ac.resume().catch(() => {});
        sysNode = ac.createMediaStreamSource(new MediaStream([sysTrack]));
        sysNode.connect(dest);
      } else if (!on && sysNode) {
        try { sysNode.disconnect(); } catch { /* ignore */ }
        sysNode = null;
      }
    },

    stop() {
      if (stopped) return;
      stopped = true;
      document.removeEventListener("pointerdown", onGesture);
      document.removeEventListener("visibilitychange", onVisibility);
      untrackCamera?.();
      untrackScreen?.();
      stopLoop();
      screen?.stream.getTracks().forEach((t) => t.stop());
      camera?.stream.getTracks().forEach((t) => t.stop());
      micStream?.getTracks().forEach((t) => t.stop());
      composite.getTracks().forEach((t) => t.stop());
      if (screen) screen.video.srcObject = null;
      if (camera) camera.video.srcObject = null;
      void ac.close().catch(() => {});
      camChrome.el?.remove();
      camChrome.el = null;
      qrChrome.el?.remove();
      qrChrome.el = null;
      canvas.remove();
    },
  };
}
