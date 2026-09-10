// Does a viewer actually HEAR the broadcast?
//
//   node scripts/e2e/audio-audible.mjs [origin]      # WF_PUBLISH_KEY optional
//
// Ported from vivoh.earth via wallflower.tv, where it caught a bug this codebase also has. Every audio assertion
// in this suite counts decoded frames, and decode -> sync -> **emit** are three stages: a
// broadcast publishing 3-byte Opus silence frames decodes exactly as happily as speech, so a
// silent stream scores a clean pass everywhere. This measures the last stage instead — what
// reaches `AudioContext.destination`. See lib/audible.mjs.
//
// Three cells:
//
//   PACED   toggle Camera, wait, toggle Audio    -> must be audible
//   FAST    the same two toggles back to back    -> must be audible  (the regression)
//   MUTED   paced broadcaster, viewer muted      -> must NOT be audible
//
// FAST is the ported bug. `applyState()` reconciles the capture toggles behind a lock that
// RETURNED when busy instead of queueing, and each pass snapshots `capture` before its awaits.
// Toggling Audio before the camera's getUserMedia resolved threw the microphone request away
// permanently -- while the button lit up. On vivoh.earth this was measured in production: 990
// Opus frames, min 3 bytes, max 3 bytes, from a source peaking at 0.99, with no error reported
// at any layer on either end. A human hits it by tapping quickly, which is what people do on
// phones, where getUserMedia is slowest. The camera's getUserMedia is deliberately slowed here
// so the race is deterministic rather than a timing lottery.
//
// MUTED is what makes a green run mean anything: <moq-watch> subscribes to audio only while
// unmuted, so it is a deliberately broken pipeline. If the probe reports sound there, it is not
// measuring what a listener hears and no other cell in the run is worth reading.

import puppeteer from "puppeteer";
import { clearSeedGate } from "./lib/seed-gate.mjs";
import { AUDIBLE_PROBE, readAudible, formatAudible, audibleFailure } from "./lib/audible.mjs";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");
const PK = process.env.WF_PUBLISH_KEY || "";
const BROADCAST_URL = `${ORIGIN}/broadcast${PK ? `?pk=${encodeURIComponent(PK)}` : ""}`;

const WATCH_MS = Number(process.env.WATCH_MS || 22000);
const PACED_GAP_MS = 2500;
// A pure-silence Opus frame is 3 bytes at any bitrate. Real speech at 64kbps runs ~100-300.
const SILENCE_FRAME_BYTES = 8;

const browser = await puppeteer.launch({
  headless: process.env.HEADFUL ? false : "new",
  args: [
    "--no-sandbox",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Frame SIZE is the corroborating evidence for the viewer's verdict, and it localizes a
// failure: all-3-byte frames mean the BROADCASTER published silence, so a silent viewer is not
// the viewer's fault.
const ENCODER_TAP = () => {
  window.__enc = { chunks: 0, bytes: 0, min: Infinity, max: 0 };
  const AE = window.AudioEncoder;
  if (!AE) return;
  window.AudioEncoder = class extends AE {
    constructor(init) {
      super({
        ...init,
        output: (chunk, meta) => {
          const s = window.__enc;
          s.chunks++;
          s.bytes += chunk.byteLength;
          if (chunk.byteLength < s.min) s.min = chunk.byteLength;
          if (chunk.byteLength > s.max) s.max = chunk.byteLength;
          init.output(chunk, meta);
        },
      });
    }
  };
};

// Hold the CAMERA's getUserMedia open so the Audio toggle is guaranteed to land while the
// reconcile pass is still awaiting it. A real camera open on a phone is far slower than the
// fake device, which is exactly why a human reaches this by tapping normally.
const SLOW_CAMERA = (ms) => {
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const stream = await gum(constraints);
    if (constraints && constraints.video) await new Promise((r) => setTimeout(r, ms));
    return stream;
  };
};

const startBroadcast = async (gapMs, { slowCameraMs = 0 } = {}) => {
  const bc = await browser.newPage();
  await bc.evaluateOnNewDocument(ENCODER_TAP);
  if (slowCameraMs > 0) await bc.evaluateOnNewDocument(SLOW_CAMERA, slowCameraMs);
  await bc.goto(BROADCAST_URL, { waitUntil: "networkidle2", timeout: 60000 });
  await bc.waitForSelector('button.publish-btn[title="Camera"]', { timeout: 30000 });
  // Inherited from the Wallflower port and a no-op here: e2eMoQ has no seeds and therefore no
  // free-seed overlay. Kept so the two suites stay diffable, not because there is a gate.
  await clearSeedGate(bc);

  await bc.click('button.publish-btn[title="Camera"]');
  await sleep(gapMs);
  const a = await bc.$('button.publish-btn[title^="Audio"]');
  if (!a) throw new Error("no Audio toggle — an audio experiment without audio proves nothing");
  await a.click();

  // The lit button is the thing that lied in the original bug, so check it AND the audio.
  await sleep(1000);
  const audioLit = await bc.evaluate(() => {
    const b = document.querySelector('button.publish-btn[title^="Audio"]');
    return !!b && b.classList.contains("toggle-on");
  });

  await bc.waitForFunction(() => /[?&]stream=[a-z0-9]{5}/.test(location.href), { polling: 500, timeout: 30000 });
  const share = await bc.evaluate(() => document.getElementById("copy-btn")?.getAttribute("data-share-url") ?? "");
  if (!share) throw new Error("no share URL on the broadcast page");
  return { bc, share, audioLit };
};

const watch = async (share, { unmute }) => {
  const [base, frag] = share.split("#");
  const ctx = await browser.createBrowserContext();
  const vw = await ctx.newPage();
  await vw.evaluateOnNewDocument(AUDIBLE_PROBE);
  await vw.evaluateOnNewDocument(() => {
    window.__decoded = 0;
    const AD = window.AudioDecoder;
    if (AD)
      window.AudioDecoder = class extends AD {
        constructor(i) {
          super({ ...i, output: (f) => { window.__decoded++; i.output(f); } });
        }
      };
  });
  await vw.goto(frag ? `${base}#${frag}` : base, { waitUntil: "networkidle2", timeout: 60000 });
  // Also a no-op here; see above.
  await clearSeedGate(vw);
  if (unmute) {
    await vw.evaluate(() => {
      const el = document.querySelector("moq-watch");
      if (el) { el.muted = false; el.paused = false; }
      document.querySelectorAll("video").forEach((v) => { v.muted = false; void v.play?.().catch(() => {}); });
    });
  }
  await sleep(WATCH_MS);
  const audible = await readAudible(vw);
  const decoded = await vw.evaluate(() => window.__decoded ?? -1);
  await vw.close();
  await ctx.close();
  return { audible, decoded };
};

const cell = async ({ gapMs, unmute, slowCameraMs }) => {
  const { bc, share, audioLit } = await startBroadcast(gapMs, { slowCameraMs });
  try {
    const { audible, decoded } = await watch(share, { unmute });
    const enc = await bc.evaluate(() => window.__enc);
    return { audioLit, audible, decoded, enc };
  } finally {
    await bc.close();
  }
};

let failed = false;
const fail = (m) => { console.error(`FAIL: ${m}`); failed = true; };

try {
  const cells = [
    { name: "PACED", gapMs: PACED_GAP_MS, unmute: true, wantAudible: true },
    { name: "FAST ", gapMs: 0, unmute: true, wantAudible: true, slowCameraMs: 2500 },
    { name: "MUTED", gapMs: PACED_GAP_MS, unmute: false, wantAudible: false },
  ];

  for (const spec of cells) {
    const r = await cell(spec);
    const avg = r.enc?.chunks ? (r.enc.bytes / r.enc.chunks).toFixed(0) : "?";
    console.log(
      `\n${spec.name}  micButtonLit=${r.audioLit}  decodedFrames=${r.decoded}\n` +
        `       encoder: ${r.enc?.chunks ?? "?"} chunks, ${r.enc?.min ?? "?"}-${r.enc?.max ?? "?"} bytes (avg ${avg})\n` +
        `       ${formatAudible(r.audible)}`
    );

    const why = audibleFailure(r.audible);
    if (spec.wantAudible && why) fail(`${spec.name}: the viewer heard nothing — ${why}`);
    if (!spec.wantAudible && !why) {
      fail(`${spec.name}: sound was measured from a MUTED viewer — the probe is not measuring what a listener hears, so no other cell in this run means anything`);
    }
    if (r.enc?.chunks > 0 && r.enc.max <= SILENCE_FRAME_BYTES) {
      fail(
        `${spec.name}: the broadcaster published DIGITAL SILENCE — ${r.enc.chunks} Opus frames, largest ${r.enc.max} bytes. ` +
          `The microphone never reached the mix (mic button lit: ${r.audioLit}).`
      );
    }
    if (spec.wantAudible && !r.audioLit) {
      fail(`${spec.name}: the Audio toggle did not light, so this cell never tested audio at all`);
    }
  }

  if (!failed) {
    console.log("\nPASS: paced and fast-click broadcasts are both audible, and a muted viewer is not.");
  }
} catch (e) {
  fail(e.message);
} finally {
  await browser.close();
}

console.log(`\naudio-audible: ${failed ? "FAIL" : "PASS"}`);
process.exit(failed ? 1 : 0);
