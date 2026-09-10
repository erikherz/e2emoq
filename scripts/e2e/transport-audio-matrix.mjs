// Dual-publish audio (#138): does EVERY transport HEAR the broadcast, and do the ones that can
// carry datagrams actually use them?
//
//   node scripts/e2e/transport-audio-matrix.mjs [origin]      # WF_PUBLISH_KEY optional
//
// e2eMoQ admits a broadcaster on a publish code (or none), not a session, so there is no
// sign-in step here — unlike vivoh.earth, where OAuth is the only publisher door and the
// suite needs its secret-gated e2e door to publish at all.
//
// THE CONTRACT UNDER TEST. Audio is published twice — "audio" as one group per frame, "audio/dg"
// as one QUIC datagram per frame — and each viewer subscribes to whichever its transport can
// receive. Datagrams open no streams, which is what escapes the ~7000-stream iOS ceiling, but
// they cannot traverse qmux/WebSocket and NOTHING falls back at any layer: not our publisher,
// not the relay ("No group fallback: otherwise off"), not the protocol ("There is no stream
// fallback"). Without a second rendition, datagram audio is a straight trade of iOS against
// every viewer whose transport is WebSocket.
//
//                       control (?adg=0, groups only)    dual-publish (the default)
//   WebTransport        audible, no datagrams            AUDIBLE VIA DATAGRAMS, low stream rate
//   WebSocket           audible, no datagrams            audible via groups, no datagrams
//
// The bottom-right cell is the whole point: a WebSocket viewer must still HEAR sound while a
// WebTransport viewer is on datagrams.
//
// WHY THIS FILE WAS REWRITTEN. Its previous version counted AudioDecoder outputs and called
// that "audio", so all four cells passed on a build that was silent everywhere — 3-byte Opus
// silence frames decode exactly as happily as speech. Every assertion now goes through
// lib/audible.mjs, which measures what reaches context.destination, and the broadcaster's own
// encoder frame sizes are reported alongside so a silent cell says WHICH end failed.
//
// Clicks are paced. Toggling Audio immediately after Camera used to drop the microphone
// entirely (see audio-audible.mjs, FAST cell); a matrix that broadcasts silence measures
// nothing about transports.
//
// ?wsonly=1 reproduces the WebSocket case on any machine by never attempting the QUIC leg while
// leaving the WebTransport API present — the state @moq's Safari UA ban puts every iPhone in.

import puppeteer from "puppeteer";
import { AUDIBLE_PROBE, readAudible, formatAudible, audibleFailure } from "./lib/audible.mjs";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");
const PK = process.env.WF_PUBLISH_KEY || "";

const WATCH_MS = Number(process.env.WATCH_MS || 22000);
const CLICK_GAP_MS = 2500;
const SILENCE_FRAME_BYTES = 8;

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--no-sandbox",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const run = async ({ dual, viewerWsOnly }) => {
  const label = `${dual ? "dual-publish" : "groups only "} / ${viewerWsOnly ? "WEBSOCKET   " : "webtransport"}`;

  const bc = await browser.newPage();
  await bc.evaluateOnNewDocument(ENCODER_TAP);
  // Dual-publish is the DEFAULT now; ?adg=0 is what strips the datagram rendition, so the
  // control arm is the flagged one. Keep that straight or the two arms silently swap and the
  // matrix reports the opposite of what it measured.
  const pk = PK ? `${dual ? "&" : "&"}pk=${encodeURIComponent(PK)}` : "";
  await bc.goto(`${ORIGIN}/broadcast?${dual ? "" : "adg=0"}${pk}`, { waitUntil: "networkidle2", timeout: 60000 });

  // Retried: the control bar is built in JS and occasionally loses a race with networkidle2.
  // A flake here silently drops a cell, and a three-cell matrix reads exactly like a four-cell one.
  let armed = false;
  for (let i = 0; i < 3 && !armed; i++) {
    try {
      await bc.waitForSelector('button.publish-btn[title="Camera"]', { timeout: 20000 });
      armed = true;
    } catch {
      await bc.reload({ waitUntil: "networkidle2", timeout: 60000 });
    }
  }
  if (!armed) throw new Error("control bar never rendered after 3 attempts");

  await bc.click('button.publish-btn[title="Camera"]');
  await sleep(CLICK_GAP_MS);
  const a = await bc.$('button.publish-btn[title^="Audio"]');
  if (!a) throw new Error("no Audio toggle — an audio experiment without audio proves nothing");
  await a.click();
  await sleep(CLICK_GAP_MS);

  await bc.waitForFunction(() => /[?&]stream=[a-z0-9]{5}/.test(location.href), { polling: 500, timeout: 30000 });
  const share = await bc.evaluate(() => document.getElementById("copy-btn")?.getAttribute("data-share-url") ?? "");
  const [base, frag] = share.split("#");
  // No rendition flag: the viewer now upgrades to datagrams on its own once the session has
  // proven it carries them. That IS the behaviour under test — a flag here would test a code
  // path no real viewer takes, since real viewers arrive by tapping a shared link.
  const url = `${base}?diag=1${viewerWsOnly ? "&wsonly=1" : ""}#${frag}`;

  const vctx = await browser.createBrowserContext();
  const vw = await vctx.newPage();
  await vw.evaluateOnNewDocument(AUDIBLE_PROBE);
  await vw.evaluateOnNewDocument(() => {
    window.__a = 0;
    window.__v = 0;
    const AD = window.AudioDecoder;
    if (AD)
      window.AudioDecoder = class extends AD {
        constructor(i) { super({ ...i, output: (f) => { window.__a++; i.output(f); } }); }
      };
    const VD = window.VideoDecoder;
    if (VD)
      window.VideoDecoder = class extends VD {
        constructor(i) { super({ ...i, output: (f) => { window.__v++; i.output(f); } }); }
      };
  });
  await vw.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
  // Unmuting is mandatory: <moq-watch> subscribes to audio only while !paused && !muted, so a
  // muted viewer measures zero audio on a stream that has it.
  await vw.evaluate(() => {
    const el = document.querySelector("moq-watch");
    if (el) { el.muted = false; el.paused = false; }
    document.querySelectorAll("video").forEach((v) => { v.muted = false; void v.play?.().catch(() => {}); });
  });

  await sleep(WATCH_MS);
  const out = await vw.evaluate(() => {
    const panel = [...document.querySelectorAll("pre,div")].find((n) => /TRANSPORT=/.test(n.textContent || ""));
    const t = panel?.textContent ?? "";
    const num = (re) => Number((t.match(re) ?? [])[1] ?? -1);
    return {
      decoded: window.__a,
      video: window.__v,
      transport: (t.match(/TRANSPORT=(\S+)/) ?? [])[1] ?? "?",
      dgramIn: num(/dgram\s+max=\S+\s+in=(\d+)/),
      streamsPerSec: Number((t.match(/streams=\d+\s+\(([\d.]+)\/s/) ?? [])[1] ?? -1),
      shape: (t.match(/shape=(\S+)/) ?? [])[1] ?? "?",
      panelFound: !!panel,
      // Captured for the failure message: "the panel was missing" is not a diagnosis, and the
      // difference between "diag was dropped from the URL" and "the panel was torn out of the
      // DOM" is the whole answer.
      href: location.href,
      preCount: document.querySelectorAll("pre").length,
      bodyHead: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 160),
    };
  });
  const audible = await readAudible(vw);
  const enc = await bc.evaluate(() => window.__enc);

  await vw.close();
  await vctx.close();
  await bc.close();
  return { label, audible, enc, ...out };
};

const cells = [
  { key: "ctrlWT", dual: false, viewerWsOnly: false },
  { key: "ctrlWS", dual: false, viewerWsOnly: true },
  { key: "dualWT", dual: true, viewerWsOnly: false },
  { key: "dualWS", dual: true, viewerWsOnly: true },
];

const got = {};
let failed = false;
const fail = (m) => { console.error(`FAIL: ${m}`); failed = true; };

try {
  for (const c of cells) {
    const r = await run(c);
    got[c.key] = r;
    const avg = r.enc?.chunks ? (r.enc.bytes / r.enc.chunks).toFixed(0) : "?";
    console.log(
      `\n${r.label}\n` +
        `   decoded=${r.decoded} video=${r.video} dgramIn=${r.dgramIn} streams/s=${r.streamsPerSec} ${r.transport}\n` +
        `   publisher: ${r.enc?.chunks ?? "?"} Opus frames, ${r.enc?.min ?? "?"}-${r.enc?.max ?? "?"} bytes (avg ${avg})\n` +
        `   ${formatAudible(r.audible)}`
    );
  }

  console.log("\n--- verdict ---");

  // 0. The publisher must not have been silent, in ANY cell. Without this the rest is theatre:
  //    a silent broadcast is inaudible on every transport and would read as four clean failures
  //    of dual-publish rather than one failure of the microphone.
  for (const [k, r] of Object.entries(got)) {
    if (r.enc?.chunks > 0 && r.enc.max <= SILENCE_FRAME_BYTES) {
      fail(`${k}: the BROADCASTER published digital silence (${r.enc.chunks} frames, max ${r.enc.max}B) — this cell tested nothing about transports`);
    }
  }

  // 1. Nobody is stranded. This is the whole point of dual-publish, and it is measured at the
  //    speakers, not at the decoder.
  for (const [k, r] of Object.entries(got)) {
    const why = audibleFailure(r.audible);
    if (why) fail(`${k} (${r.label.trim()}): the viewer heard NOTHING — ${why}`);
    if (r.video <= 0) fail(`${k}: no video decoded — the run itself was broken, not the audio path`);
  }

  // 1b. Every transport claim below is read out of the diag panel. If the panel could not be
  //     read, `dgramIn` is -1 and `transport` is "?" — and -1 would sail straight through the
  //     "control received no datagrams" check as a pass. That is an instrument reporting its
  //     own absence as a measurement, which has cost this project entire afternoons. Fail.
  for (const [k, r] of Object.entries(got)) {
    if (!r.panelFound || r.dgramIn < 0) {
      fail(
        `${k}: the diag panel could not be read, so every transport figure for this cell is missing rather than zero\n` +
          `        href=${r.href}\n        <pre> count=${r.preCount}  body="${r.bodyHead}"`
      );
    }
  }

  // 2. The control must NOT use datagrams, or "datagrams were used" below means nothing.
  if (got.ctrlWT?.dgramIn > 0) fail("control (?adg=0) received datagrams — the flag did not strip the second rendition");

  // 3. A datagram-capable viewer must actually be ON datagrams under dual-publish.
  if (!(got.dualWT?.dgramIn > 0)) fail("dual-publish + WebTransport received NO datagrams — the viewer stayed on the group rendition");

  // 4. THE CLAIM: a WebSocket viewer still hears audio while WT viewers are on datagrams, and
  //    does not somehow receive datagrams its transport cannot carry.
  if (got.dualWS?.dgramIn > 0) fail("WebSocket viewer reported datagrams — impossible; the probe or the label is wrong");

  // 5. The stream-rate benefit must survive dual-publish: a WT viewer subscribes to ONE
  //    rendition, so publishing a second must not put audio groups back on its wire.
  const c = got.ctrlWT?.streamsPerSec ?? -1;
  const d = got.dualWT?.streamsPerSec ?? -1;
  if (c > 0 && d > 0 && d > c * 0.5) {
    fail(`stream rate did not collapse under dual-publish (${c}/s -> ${d}/s); the datagram viewer is still pulling audio groups`);
  }

  if (!failed) {
    console.log("PASS: every transport HEARD audio; WebTransport used datagrams; WebSocket fell back to groups.");
    if (c > 0 && d > 0) {
      console.log(`Stream rate ${c}/s -> ${d}/s for the datagram viewer (${(100 * (1 - d / c)).toFixed(0)}% lower).`);
    }
  }
} catch (e) {
  console.error(`\nFAIL: ${e.message}`);
  failed = true;
} finally {
  await browser.close();
}

console.log(`\ntransport-audio-matrix: ${failed ? "FAIL" : "PASS"}`);
process.exit(failed ? 1 : 0);
