// Does the camera preview survive a failure that happens AFTER capture starts?
//
// Reported 2026-08-28 on Edge/Windows: the camera "does not stay open — I see it for a
// second and then it goes away". Chromium on a healthy network cannot reproduce it
// (scripts/e2e/camera-stays-on.mjs passes), so the interesting question is what the page
// does when something downstream of getUserMedia fails — which is what a corporate/consumer
// Windows firewall blocking UDP, or a missing hardware encoder, actually looks like.
//
//   node scripts/e2e/camera-survives-failure.mjs [origin] [wt|encoder|none]
//
// Failure injected before any page script runs:
//   wt       — WebTransport constructs but never becomes ready (UDP blocked / QUIC filtered)
//   encoder  — VideoEncoder.isConfigSupported says no, and configure() throws
//   none     — control run
//
// The camera preview is OUR canvas; it does not depend on the relay or the encoder. So the
// invariant is: whatever fails downstream, capture stays up and the broadcaster keeps
// seeing themselves. Exit 1 if the preview dies.

import puppeteer from "puppeteer";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");
const MODE = process.argv[3] || "wt";
const PK = process.env.WF_PUBLISH_KEY || "";
const URL = `${ORIGIN}/broadcast${PK ? `?pk=${encodeURIComponent(PK)}` : ""}`;
const SECONDS = Number(process.env.WATCH_SECONDS || 15);

const log = [];
let bad = null;
const fail = (m) => {
  bad = m;
  process.exitCode = 1;
};

const BREAK = {
  wt: () => {
    const Real = window.WebTransport;
    if (!Real) return;
    window.WebTransport = class {
      constructor(...a) {
        this.__args = a;
        this.ready = new Promise((_, rej) =>
          setTimeout(() => rej(new DOMException("simulated: UDP blocked", "NetworkError")), 300)
        );
        this.closed = new Promise(() => {});
        this.ready.catch(() => {});
      }
      close() {}
      createBidirectionalStream() {
        return Promise.reject(new Error("simulated: no transport"));
      }
      get datagrams() {
        return { readable: new ReadableStream(), writable: new WritableStream() };
      }
      get incomingBidirectionalStreams() {
        return new ReadableStream();
      }
    };
  },
  encoder: () => {
    if (!window.VideoEncoder) return;
    window.VideoEncoder.isConfigSupported = async (c) => ({ supported: false, config: c });
    const proto = window.VideoEncoder.prototype;
    proto.configure = function () {
      throw new DOMException("simulated: no hardware encoder", "NotSupportedError");
    };
  },
  none: () => {},
};

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on("pageerror", (e) => log.push(`[pageerror] ${e.message}`));
  page.on("console", (m) => log.push(`[${m.type()}] ${m.text()}`));

  if (!BREAK[MODE]) throw new Error(`unknown mode ${MODE}`);
  await page.evaluateOnNewDocument(BREAK[MODE]);

  console.log(`  opening ${ORIGIN}/broadcast with failure mode: ${MODE}`);
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector("button.toggle-btn", { timeout: 30000 });

  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button.toggle-btn")].find((x) =>
      (x.title || "").toLowerCase().startsWith("camera")
    );
    if (!b) return false;
    b.click();
    return true;
  });
  if (!clicked) throw new Error("no Camera toggle in the control bar");
  console.log("  clicked Camera");

  const sample = () =>
    page.evaluate(() => {
      const btn = [...document.querySelectorAll("button.toggle-btn")].find((x) =>
        (x.title || "").toLowerCase().startsWith("camera")
      );
      const cv = document.querySelector("canvas.pip-canvas");
      const out = { on: !!btn?.classList.contains("toggle-on"), canvas: !!cv, sum: null };
      if (cv) {
        const c = document.createElement("canvas");
        c.width = 64;
        c.height = 36;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        try {
          ctx.drawImage(cv, 0, 0, 64, 36);
          const { data } = ctx.getImageData(0, 0, 64, 36);
          let s = 0;
          for (let i = 0; i < data.length; i += 4) s = (s + (data[i] + data[i + 1] + data[i + 2]) * (i + 1)) >>> 0;
          out.sum = s;
        } catch (e) {
          out.sum = `draw failed: ${e.message}`;
        }
      }
      return out;
    });

  const seen = [];
  for (let t = 0; t < SECONDS; t++) {
    await new Promise((r) => setTimeout(r, 1000));
    const s = await sample();
    seen.push(s);
    console.log(`  t=${t + 1}s on=${s.on} canvas=${s.canvas} sum=${s.sum}`);
  }

  const off = seen.findIndex((s) => !s.on);
  const gone = seen.findIndex((s) => !s.canvas);
  const sums = seen.map((s) => s.sum).filter((v) => typeof v === "number");
  const frozen = sums.length > 3 && new Set(sums.slice(-4)).size === 1;

  if (off >= 0) fail(`[${MODE}] capture switched itself OFF at t=${off + 1}s`);
  else if (gone >= 0) fail(`[${MODE}] preview canvas left the DOM at t=${gone + 1}s`);
  else if (frozen) fail(`[${MODE}] preview froze — canvas stopped changing`);
  else console.log(`\nPASS [${MODE}]: preview survived the failure`);
} catch (e) {
  fail(e.message);
} finally {
  await browser.close();
  if (bad) console.error(`\nFAIL: ${bad}`);
  console.log("\n--- page log ---");
  for (const l of log) console.log(l);
}
