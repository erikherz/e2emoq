// The location + time burn-in, checked on the deployed site.
//
//   node scripts/e2e/geo-stamp.mjs [origin]                 # endpoint checks only
//   WF_PUBLISH_KEY=<code> node scripts/e2e/geo-stamp.mjs    # + the burn-in in the picture
//
// Two things worth testing beyond "the button exists":
//   - /api/whereami must not honour the ?geo= override that relay routing accepts, or a
//     "proof" burn-in could be forged with a query string.
//   - the text must reach the COMPOSITED CANVAS, not just the DOM. That canvas is what gets
//     encoded, so sampling its pixels is the only check that proves viewers see this.

import puppeteer from "puppeteer";
import { clearSeedGate } from "./lib/seed-gate.mjs";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");
const PK = process.env.WF_PUBLISH_KEY || "";

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};
const note = (m) => console.log(`  --    ${m}`);

console.log(`\n/api/whereami @ ${ORIGIN}\n`);

const res = await fetch(`${ORIGIN}/api/whereami`);
check("responds 200", res.status, 200);
check("is uncacheable", /no-store/.test(res.headers.get("cache-control") || ""), true);

const body = await res.json();
note(`edge says: ${body.city ?? "?"}, ${body.country ?? "?"} (${body.lat}, ${body.lon}) via ${body.colo ?? "?"}`);
check("carries coordinates", typeof body.lat === "number" && typeof body.lon === "number", true);
check("declares its precision honestly", body.precision, "city");
check("declares its source", body.source, "cloudflare-ip-geo");

// The burned-in clock is only worth anything if the edge clock is real. A few seconds of
// slop is fine (that is what the client's offset correction is for); minutes is not.
const skew = Math.abs(body.server_time_ms - Date.now());
check("the edge clock agrees with ours to within 60s", skew < 60_000, true);
note(`skew ${Math.round(skew)}ms`);

// The relay-routing test override must NOT reach this endpoint.
const spoofed = await (await fetch(`${ORIGIN}/api/whereami?geo=1.5,2.5`)).json();
check("?geo= cannot forge the location", spoofed.lat === 1.5 && spoofed.lon === 2.5, false);

// Nothing about the caller should be persisted. We can't read D1 from here, so this is the
// weaker but still useful check: a second call must not accumulate anything about the first.
check("the response carries no identifier for the caller",
  Object.keys(body).some((k) => /id|token|session|ip|hash/i.test(k)), false);

if (!PK) {
  console.log("\n(set WF_PUBLISH_KEY to also check the burn-in reaches the canvas)");
  console.log(failures ? `\n${failures} failed\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
}

console.log(`\nburn-in in the composited picture\n`);

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});

// Fraction of near-white pixels in the bottom strip of the published canvas. The burn-in is
// white text on a dark bar, so it moves this number hard; the fake camera pattern does not.
const bandStats = () => {
  const c = document.querySelector("canvas.pip-canvas");
  if (!c || c.width < 640) return null;
  const H = 40;
  const probe = document.createElement("canvas");
  probe.width = c.width;
  probe.height = H;
  const x = probe.getContext("2d", { willReadFrequently: true });
  x.drawImage(c, 0, c.height - H, c.width, H, 0, 0, c.width, H);
  const d = x.getImageData(0, 0, c.width, H).data;
  let white = 0;
  let dark = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) white++;
    if (d[i] + d[i + 1] + d[i + 2] < 150) dark++;
  }
  const n = d.length / 4;
  return { white: white / n, dark: dark / n };
};

// The burned-in text can't be read back out of the canvas without OCR, but the two things
// worth asserting about it announce themselves on the console: which source the coordinates
// came from, and how good the clock is. No test hooks in the product code.
const LOGS = [];

try {
  // A device fix, granted and pinned, so "±12m" is the expected path rather than a matter of
  // where CI happens to be sitting.
  await browser.defaultBrowserContext().overridePermissions(ORIGIN, ["geolocation"]);

  const page = await browser.newPage();
  page.on("console", (m) => LOGS.push(m.text()));
  page.on("dialog", (d) => void d.accept()); // the one-time "show your location?" confirm
  await page.setGeolocation({ latitude: 37.774929, longitude: -122.419418, accuracy: 12 });
  await page.goto(`${ORIGIN}/broadcast?pk=${encodeURIComponent(PK)}`, { waitUntil: "networkidle2", timeout: 60000 });

  await page.waitForSelector("#stamp-btn", { timeout: 20000 });
  // Before any real click: see lib/seed-gate.mjs. This suite used to die here with
  // "Node is either not clickable or not an Element", which names the overlay not at all.
  await clearSeedGate(page, note);
  check("the stamp button is in the control bar", true, true);
  check("it starts off", await page.evaluate(() => document.getElementById("stamp-btn").classList.contains("toggle-on")), false);

  // Camera first, so there is a composite to draw onto.
  await page.evaluate(() => document.querySelector('.publish-btn.toggle-btn[title^="Camera"]').click());
  await page.waitForFunction(() => {
    const c = document.querySelector("canvas.pip-canvas");
    return c && c.width >= 640;
  }, { timeout: 30000, polling: 300 });

  const before = await page.evaluate(bandStats);
  note(`strip before: white ${(before.white * 100).toFixed(2)}%  dark ${(before.dark * 100).toFixed(2)}%`);

  // The stamp lives inside the More disclosure, collapsed by default since 2026-08-28. A real
  // click needs the panel open first; without it the button is display:none and puppeteer says
  // "Node is either not clickable or not an Element", which names the panel not at all. This
  // suite had been stale since that change and nobody had run it since.
  const openMore = async () => {
    if (await page.evaluate(() => !!document.getElementById("stamp-btn")?.offsetParent)) return;
    await page.evaluate(() => document.querySelector(".publish-btn.more-btn")?.click());
    await page.waitForFunction(() => !!document.getElementById("stamp-btn")?.offsetParent, { timeout: 10000 });
  };
  await openMore();
  await page.click("#stamp-btn");
  await page.waitForFunction(() => document.getElementById("stamp-btn").classList.contains("toggle-on"), { timeout: 20000 });
  check("clicking it turns it on", true, true);

  // Wait on the TEXT, not on the bar behind it.
  //
  // The obvious check — "a dark bar appeared" — is useless here and was wrong when first
  // written: the strip already measures ~100% dark before the stamp exists, because the
  // canvas starts black and Chrome's fake camera pattern is dark along the bottom. Only the
  // white glyph pixels actually distinguish stamp from no-stamp, and they do it cleanly
  // (0% -> ~9% -> 0% across a toggle).
  const WHITE_MIN = 0.002;
  await page.waitForFunction(
    (h, min) => {
      const c = document.querySelector("canvas.pip-canvas");
      if (!c) return false;
      const p = document.createElement("canvas");
      p.width = c.width; p.height = h;
      const x = p.getContext("2d", { willReadFrequently: true });
      x.drawImage(c, 0, c.height - h, c.width, h, 0, 0, c.width, h);
      const d = x.getImageData(0, 0, c.width, h).data;
      let white = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) white++;
      }
      return white / (d.length / 4) > min;
    },
    { timeout: 30000, polling: 300 },
    40,
    WHITE_MIN
  );

  const on = await page.evaluate(bandStats);
  note(`strip on:     white ${(on.white * 100).toFixed(2)}%  dark ${(on.dark * 100).toFixed(2)}%`);
  check("burned-in text appears in the strip", on.white > before.white + 0.01, true);

  // The clock has to be running: two samples a beat apart must differ. This is what makes it
  // usable as a latency reference rather than a static caption.
  const sig = () => {
    const c = document.querySelector("canvas.pip-canvas");
    const p = document.createElement("canvas");
    p.width = c.width; p.height = 40;
    const x = p.getContext("2d", { willReadFrequently: true });
    x.drawImage(c, 0, c.height - 40, c.width, 40, 0, 0, c.width, 40);
    return p.toDataURL().length + ":" + p.toDataURL().slice(-64);
  };
  const s1 = await page.evaluate(sig);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
  const s2 = await page.evaluate(sig);
  check("the burned-in clock is moving", s1 !== s2, true);

  // And it must come back off. An ON control is promoted out of the menu, so it may have
  // moved into the main row by now — openMore() is a no-op when it is already visible.
  await openMore();
  await page.click("#stamp-btn");
  await page.waitForFunction(() => !document.getElementById("stamp-btn").classList.contains("toggle-on"), { timeout: 10000 });
  await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
  const off = await page.evaluate(bandStats);
  note(`strip off:    white ${(off.white * 100).toFixed(2)}%  dark ${(off.dark * 100).toFixed(2)}%`);
  check("turning it off clears the strip", off.white < WHITE_MIN, true);

  // ---- what the line actually says ----
  const clockLog = LOGS.find((l) => /\[clock\] anchored to the edge/.test(l)) || "";
  check("the clock anchors to the edge, not the device", !!clockLog, true);
  note(clockLog);
  // Best-of-5 against an edge should land in single-digit or low-double-digit ms. A loose
  // bound here still catches the real regression: falling back to a one-shot estimate.
  const uncertainty = Number((clockLog.match(/±([\d.]+)ms/) || [])[1]);
  check("the clock reports its uncertainty", Number.isFinite(uncertainty), true);
  check("and it is better than 250ms", uncertainty < 250, true);

  // The stamp must describe when the frame was CAPTURED, not when we drew it — the gap is the
  // camera pipeline, tens of ms, the same order as the latency this is used to measure.
  const timingLog = LOGS.find((l) => /\[compositor\] frame timing available/.test(l)) || "";
  check("per-frame capture timing is wired up", !!timingLog, true);
  note(timingLog);
  const mode = (timingLog.match(/available: (\w+)/) || [])[1];
  if (mode !== "capture") {
    // Not a failure: captureTime is only populated for sources the UA knows it for, and a
    // fake device in headless Chrome is not a real camera. Worth surfacing loudly, because on
    // a real camera anything but "capture" means the burn-in is stamping draw time.
    note(`WARNING: frame timing is "${mode}", not "capture" — the line will mark itself with a leading ≈`);
  }

  check("a granted device fix is used", LOGS.some((l) => /device fix acquired/.test(l)), true);
  check("and it is not silently the network fallback",
    LOGS.some((l) => /falling back to network location/.test(l)), false);

  // Stop capture so the broadcast row is closed rather than left for the reaper. There is no
  // Stop button — turning the last input off is what ends a broadcast.
  await page.evaluate(() => {
    document.querySelectorAll(".publish-btn.toggle-btn.toggle-on").forEach((b) => b.click());
  });
  await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));
  await page.close();

  // ---- refused permission must degrade honestly, not silently ----
  //
  // The whole design rests on the line distinguishing a metres-accurate fix from a city
  // centroid. A build that quietly showed six decimals of IP geolocation would pass every
  // pixel check above and be exactly the false confidence this feature is meant to prevent.
  const denied = await browser.createBrowserContext(); // no geolocation permission granted
  const p2 = await denied.newPage();
  const L2 = [];
  p2.on("console", (m) => L2.push(m.text()));
  p2.on("dialog", (d) => void d.accept());
  await p2.goto(`${ORIGIN}/broadcast?pk=${encodeURIComponent(PK)}`, { waitUntil: "networkidle2", timeout: 60000 });
  await p2.waitForSelector("#stamp-btn", { timeout: 20000 });
  // Fresh context, so both gates apply again: the free-seed overlay, then the More panel.
  await clearSeedGate(p2, note);
  await p2.evaluate(() => {
    if (!document.getElementById("stamp-btn")?.offsetParent) {
      document.querySelector(".publish-btn.more-btn")?.click();
    }
  });
  await p2.waitForFunction(() => !!document.getElementById("stamp-btn")?.offsetParent, { timeout: 10000 });
  await p2.click("#stamp-btn");
  await p2.waitForFunction(() => document.getElementById("stamp-btn").classList.contains("toggle-on"), { timeout: 20000 });
  // watchPosition's error callback can take until its own timeout to fire.
  try {
    await p2.waitForFunction(() => true, { timeout: 1000 });
  } catch { /* nothing to wait on; the sleep below is the real wait */ }
  await p2.evaluate(() => new Promise((r) => setTimeout(r, 22000)));
  check("a refused fix falls back to the network location",
    L2.some((l) => /falling back to network location/.test(l)), true);
  check("and does not claim a device fix",
    L2.some((l) => /device fix acquired/.test(l)), false);
  await denied.close();
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} failed\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
