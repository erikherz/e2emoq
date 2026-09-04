// Does the camera STAY on after you press Camera?
//
// Reported 2026-08-28 on Edge/Windows: "when I try to enable the camera, it does not stay
// open. I see it for a second and then it goes away." The same build was fine on macOS and
// iOS — which is a Chromium-vs-WebKit split as much as an Edge-vs-anything one, so this runs
// the broadcaster in headless Chromium (Edge's engine) with a fake camera and simply watches
// the capture state for a while.
//
//   node --env-file=/tmp/wf.env scripts/e2e/camera-stays-on.mjs [origin]
//
// It samples once a second for ~20s and reports the first moment any of these flips:
//   - the Camera button loses .toggle-on   (applyState's catch ran: capture was torn down)
//   - the compositor canvas leaves the DOM  (teardownComposite / comp.stop())
//   - the canvas stops changing             (frames stopped arriving; preview frozen)
// Every console message and page error is kept, so a failure names its own cause.
//
// Exit 0 = camera still capturing at the end. Exit 1 = it went away.

import puppeteer from "puppeteer";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");
const PK = process.env.WF_PUBLISH_KEY || "";
const URL = `${ORIGIN}/broadcast${PK ? `?pk=${encodeURIComponent(PK)}` : ""}`;
const SECONDS = Number(process.env.WATCH_SECONDS || 20);

const log = [];
const fail = (m) => {
  console.error(`\nFAIL: ${m}`);
  process.exitCode = 1;
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
  page.on("requestfailed", (r) => log.push(`[netfail] ${r.url()} ${r.failure()?.errorText}`));
  page.on("response", (r) => {
    if (r.status() >= 400) log.push(`[http ${r.status()}] ${r.url()}`);
  });

  console.log(`  opening ${ORIGIN}/broadcast`);
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 60000 });

  // The control bar is built by main.ts after the moq elements register.
  await page.waitForSelector("button.toggle-btn", { timeout: 30000 });

  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button.toggle-btn")].find(
      (x) => (x.title || "").toLowerCase().startsWith("camera")
    );
    if (!b) return false;
    b.click();
    return true;
  });
  if (!clicked) throw new Error("no Camera toggle in the control bar");
  console.log("  clicked Camera");

  // One sample: is capture still on, is the canvas still there, is it still painting?
  const sample = () =>
    page.evaluate(() => {
      const btn = [...document.querySelectorAll("button.toggle-btn")].find(
        (x) => (x.title || "").toLowerCase().startsWith("camera")
      );
      const cv = document.querySelector("canvas.pip-canvas");
      const out = {
        on: !!btn?.classList.contains("toggle-on"),
        canvas: !!cv,
        w: cv?.width || 0,
        h: cv?.height || 0,
        shown: cv ? cv.getBoundingClientRect().width : 0,
        tracks: [],
        sum: null,
      };
      // Live camera tracks the page still holds.
      for (const v of document.querySelectorAll("video")) {
        const s = v.srcObject;
        if (!s || typeof s.getVideoTracks !== "function") continue;
        for (const t of s.getVideoTracks()) out.tracks.push(`${t.label || "?"}:${t.readyState}`);
      }
      if (cv) {
        const c = document.createElement("canvas");
        c.width = 64;
        c.height = 36;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        try {
          ctx.drawImage(cv, 0, 0, 64, 36);
          const { data } = ctx.getImageData(0, 0, 64, 36);
          let sum = 0;
          for (let i = 0; i < data.length; i += 4) sum = (sum + (data[i] + data[i + 1] + data[i + 2]) * (i + 1)) >>> 0;
          out.sum = sum;
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
    console.log(
      `  t=${t + 1}s on=${s.on} canvas=${s.canvas} ${s.w}x${s.h} shown=${Math.round(s.shown)} ` +
        `sum=${s.sum} tracks=${s.tracks.join(",") || "none"}`
    );
  }

  const last = seen[seen.length - 1];
  const wentOff = seen.findIndex((s) => !s.on);
  const canvasGone = seen.findIndex((s) => !s.canvas);
  const sums = seen.map((s) => s.sum).filter((v) => typeof v === "number");
  const frozen = sums.length > 3 && new Set(sums.slice(-4)).size === 1;

  if (wentOff >= 0) fail(`capture switched itself OFF at t=${wentOff + 1}s (applyState catch ran)`);
  else if (canvasGone >= 0) fail(`compositor canvas left the DOM at t=${canvasGone + 1}s`);
  else if (frozen) fail("canvas stopped changing — frames are no longer arriving");
  else if (!last.canvas || !last.on) fail("camera is not capturing at the end");
  else console.log("\nPASS: camera still capturing after " + SECONDS + "s");
} catch (e) {
  fail(e.message);
} finally {
  await browser.close();
  console.log("\n--- page log ---");
  for (const l of log) console.log(l);
}
