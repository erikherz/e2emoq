// When the camera goes away, does the broadcaster get told?
//
// Windows hands a camera to one app at a time, which produces two failures no other platform
// shows much of. Reported 2026-08-28 from Edge on Windows as "the camera does not stay open —
// I see it for a second and then it goes away":
//
//   REFUSED   getUserMedia rejects with NotReadableError ("Could not start video source")
//             because something else already holds the camera.
//   YANKED    capture starts, then the OS takes the camera back — Teams waking up, the Camera
//             app, a driver reset. The track ends, the hidden <video> drops to zero
//             dimensions, drawCover paints nothing, and the composite becomes a black
//             rectangle. The Camera button stays lit and viewers get black.
//
// Both used to end in a console.error and nothing else. This asserts the thing that actually
// matters to a broadcaster: the button reflects reality and something on screen says why.
//
//   node scripts/e2e/camera-yanked.mjs [origin]
//
// Runs against a LOCAL `vite preview` as happily as against production — nothing here needs
// the Worker, a relay or a publish key, so it is one of the few tests that can run BEFORE a
// deploy. Exit 0 = both scenarios reported themselves.

import puppeteer from "puppeteer";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");
const PK = process.env.WF_PUBLISH_KEY || "";
const URL = `${ORIGIN}/broadcast${PK ? `?pk=${encodeURIComponent(PK)}` : ""}`;

const failures = [];
const fail = (m) => {
  failures.push(m);
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

// Keep every stream getUserMedia hands out, so a scenario can end one later.
const KEEP_STREAMS = () => {
  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  window.__streams = [];
  navigator.mediaDevices.getUserMedia = async (c) => {
    const s = await real(c);
    window.__streams.push(s);
    return s;
  };
};

// Refuse video the way Windows does. Audio still works — that asymmetry is real, and it is
// what makes the camera the only button that fails.
//
// Built as a factory because evaluateOnNewDocument serialises the function, so the error it
// should throw has to be baked into the source rather than closed over.
const refuseVideo = (name, message) =>
  new Function(`
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => {
      if (c && c.video) throw new DOMException(${JSON.stringify(message)}, ${JSON.stringify(name)});
      return real(c);
    };
  `);

const STATE = (page) =>
  page.evaluate(() => {
    const btn = [...document.querySelectorAll("button.toggle-btn")].find((x) =>
      (x.title || "").toLowerCase().startsWith("camera")
    );
    const cv = document.querySelector("canvas.pip-canvas");
    let lit = null;
    if (cv) {
      const c = document.createElement("canvas");
      c.width = 64;
      c.height = 36;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(cv, 0, 0, 64, 36);
      const { data } = ctx.getImageData(0, 0, 64, 36);
      lit = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] + data[i + 1] + data[i + 2] > 30) lit++;
      }
    }
    const n = document.querySelector(".capture-notice");
    return {
      on: !!btn?.classList.contains("toggle-on"),
      canvas: !!cv,
      lit, // of 2304 sampled pixels, how many are not near-black
      note: n && !n.classList.contains("hidden") ? (n.textContent || "").trim() : "",
    };
  });

const open = async (prep) => {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.evaluateOnNewDocument(prep);
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector("button.toggle-btn", { timeout: 30000 });
  await page.evaluate(() => {
    [...document.querySelectorAll("button.toggle-btn")]
      .find((x) => (x.title || "").toLowerCase().startsWith("camera"))
      ?.click();
  });
  return page;
};

try {
  // ── 1. REFUSED ────────────────────────────────────────────────────────────────────
  //
  // Two ways to be told no, and they need DIFFERENT advice: closing Teams does nothing for a
  // desktop with no webcam in it, which is what the original report turned out to be. The
  // failure that matters is a generic "capture could not start" for both.
  const REFUSALS = [
    {
      what: "camera already in use by another app",
      name: "NotReadableError",
      message: "Could not start video source",
      wants: /only one app/i,
    },
    {
      what: "no camera attached to the machine at all",
      name: "NotFoundError",
      message: "Requested device not found",
      wants: /no camera or microphone was found/i,
    },
  ];
  for (const r of REFUSALS) {
    console.log(`\n  scenario: ${r.what}`);
    const a = await open(refuseVideo(r.name, r.message));
    await new Promise((s) => setTimeout(s, 2500));
    const refused = await STATE(a);
    console.log(`    on=${refused.on} note="${refused.note}"`);
    if (refused.on) fail(`${r.name}: the Camera button stayed lit after getUserMedia refused`);
    if (!refused.note) fail(`${r.name}: nothing on screen explains why the camera did not start`);
    else if (!r.wants.test(refused.note)) {
      fail(`${r.name}: the notice does not name this cause — "${refused.note}"`);
    }
    await a.close();
  }

  // ── 2. YANKED ─────────────────────────────────────────────────────────────────────
  console.log("\n  scenario: camera taken away mid-capture");
  const b = await open(KEEP_STREAMS);
  await new Promise((r) => setTimeout(r, 4000));
  const before = await STATE(b);
  console.log(`    before: on=${before.on} canvas=${before.canvas} lit=${before.lit}/2304`);
  if (!before.lit) fail("yanked: the camera never painted anything — scenario is meaningless");

  const n = await b.evaluate(() => {
    let k = 0;
    for (const s of window.__streams || []) {
      for (const t of s.getVideoTracks()) {
        t.stop();
        // stop() does not fire "ended" — the spec only fires it when the source ends by
        // itself, which IS what the OS taking the camera does. Raise it explicitly.
        t.dispatchEvent(new Event("ended"));
        k++;
      }
    }
    return k;
  });
  console.log(`    stopped ${n} camera track(s) from outside the app`);
  await new Promise((r) => setTimeout(r, 2000));
  const after = await STATE(b);
  console.log(`    after:  on=${after.on} canvas=${after.canvas} lit=${after.lit}/2304 note="${after.note}"`);
  if (after.on) fail("yanked: the Camera button is still lit over a dead source");
  if (!after.note) fail("yanked: the camera died and nothing on screen says so");
  await b.close();

  if (!failures.length) console.log("\nPASS: both camera failures report themselves");
} catch (e) {
  fail(e.message);
} finally {
  await browser.close();
  for (const f of failures) console.error(`\nFAIL: ${f}`);
}
