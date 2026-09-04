// How bad is the seam when a viewer's token is renewed mid-stream?
//
// cdn.moq.pro drops a session at token expiry (scripts/e2e/token-expiry.mjs), so enforceable
// termination means short tokens, which means renewing them live. The open question is what
// that costs the viewer: re-pointing <moq-watch> at a fresh URL might be seamless, might
// stutter, or might break playback outright — that element is already known not to survive a
// track reset, which is why the compositor pins a fixed canvas.
//
// Measured in-page at 200ms rather than by round-tripping each sample through Node, because
// the thing being measured is a gap of a few hundred milliseconds and the round trip is a
// meaningful fraction of that.
//
//   WF_PUBLISH_KEY=<key> node scripts/e2e/token-renewal-seam.mjs [origin] [ttl] [watchSeconds]

import puppeteer from "puppeteer";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");
const TTL = Number(process.argv[3] || 40);
const WATCH = Number(process.argv[4] || 100);
const PK = process.env.WF_PUBLISH_KEY || "";
const STEP = (m) => console.log(`  ${m}`);

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

try {
  // ── Publish ────────────────────────────────────────────────────────────────────────────
  const bc = await browser.newPage();
  await bc.goto(`${ORIGIN}/broadcast${PK ? `?pk=${encodeURIComponent(PK)}` : ""}`, {
    waitUntil: "networkidle2", timeout: 60000,
  });
  await bc.waitForSelector('button.publish-btn[title="Camera"]', { timeout: 30000 });
  await bc.click('button.publish-btn[title="Camera"]');
  await bc.waitForFunction(() => /[?&]stream=[a-z0-9]{5}/.test(location.href), { timeout: 30000 });
  const streamId = await bc.evaluate(() => new URLSearchParams(location.search).get("stream"));
  await bc.waitForFunction(
    () => [...document.querySelectorAll("video,canvas")].some((el) => (el.videoWidth || el.width || 0) >= 320),
    { timeout: 45000 }
  );
  const shareUrl = await bc.evaluate(() => document.getElementById("copy-btn")?.getAttribute("data-share-url") ?? "");
  STEP(`broadcasting ${streamId}`);
  await new Promise((r) => setTimeout(r, 5000));

  // ── Watch with a short token so renewal happens quickly ────────────────────────────────
  const [base, frag] = shareUrl.split("#");
  const ctx = await browser.createBrowserContext();
  const vw = await ctx.newPage();

  const tokenLog = [];
  vw.on("console", (m) => {
    const t = m.text();
    if (t.includes("[token]")) tokenLog.push({ at: Date.now(), text: t });
  });

  let grantedTtl = null;
  vw.on("response", async (r) => {
    if (!/\/route(\?|$)/.test(r.url())) return;
    try {
      const body = await r.json();
      if (!body.jwt) return;
      const claims = JSON.parse(Buffer.from(body.jwt.split(".")[1], "base64url").toString());
      if (typeof claims.exp === "number" && grantedTtl === null) {
        grantedTtl = claims.exp - Math.floor(Date.now() / 1000);
      }
    } catch { /* not a route response */ }
  });

  await vw.goto(`${base}?ttl=${TTL}#${frag}`, { waitUntil: "networkidle2", timeout: 60000 });
  await vw.waitForFunction(
    () => [...document.querySelectorAll("video,canvas")].some((el) => (el.videoWidth || el.width || 0) >= 640),
    { timeout: 60000 }
  );
  await vw.waitForFunction(
    () => {
      const el = [...document.querySelectorAll("video,canvas")].filter((e) => (e.videoWidth || e.width || 0) >= 640)[0];
      if (!el) return false;
      const c = document.createElement("canvas");
      c.width = 64; c.height = 36;
      const x = c.getContext("2d", { willReadFrequently: true });
      try { x.drawImage(el, 0, 0, 64, 36); } catch { return false; }
      const d = x.getImageData(0, 0, 64, 36).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) lit++;
      return lit > (d.length / 4) * 0.05;
    },
    { timeout: 60000, polling: 500 }
  );

  if (grantedTtl === null || Math.abs(grantedTtl - TTL) > 15) {
    throw new Error(`token lifetime is ${grantedTtl}s, not ~${TTL}s — the ?ttl= override did not take effect`);
  }
  // The page must have SCHEDULED a renewal before sampling starts. Without this the test
  // happily measures a build that has no renewal code — which is how the first run "proved"
  // the swap was fatal when it had simply never been attempted. A stale edge is the norm here,
  // not the exception.
  if (!tokenLog.some((l) => l.text.includes("renewing in"))) {
    throw new Error(
      "the page never scheduled a renewal — it is running a build without the renewal code " +
      "(stale edge). Nothing measurable here."
    );
  }
  STEP(`viewer connected with a ${grantedTtl}s token; sampling for ${WATCH}s`);

  // ── In-page sampler ────────────────────────────────────────────────────────────────────
  await vw.evaluate(() => {
    window.__seam = [];
    const pick = () =>
      [...document.querySelectorAll("video,canvas")]
        .map((el) => ({ el, w: el.videoWidth || el.width || 0, h: el.videoHeight || el.height || 0 }))
        .filter((m) => m.w >= 640)
        .sort((a, b) => b.w * b.h - a.w * a.h)[0];
    const c = document.createElement("canvas");
    c.width = 64; c.height = 36;
    const x = c.getContext("2d", { willReadFrequently: true });
    window.__seamTimer = setInterval(() => {
      const m = pick();
      if (!m) { window.__seam.push({ t: performance.now(), sum: -1, lit: -1 }); return; }
      try { x.drawImage(m.el, 0, 0, 64, 36); } catch { window.__seam.push({ t: performance.now(), sum: -2, lit: -2 }); return; }
      const d = x.getImageData(0, 0, 64, 36).data;
      let sum = 0, lit = 0;
      for (let i = 0; i < d.length; i += 4) {
        const v = d[i] + d[i + 1] + d[i + 2];
        sum = (sum + v * (i + 1)) >>> 0;
        if (v > 30) lit++;
      }
      window.__seam.push({ t: performance.now(), sum, lit });
    }, 200);
  });

  await new Promise((r) => setTimeout(r, WATCH * 1000));
  const samples = await vw.evaluate(() => { clearInterval(window.__seamTimer); return window.__seam; });

  // ── Analysis ───────────────────────────────────────────────────────────────────────────
  // A gap = consecutive samples with an identical checksum. The fake camera pattern moves
  // constantly, so any run beyond one sample interval is a real stall in decoding.
  const gaps = [];
  let runStart = null;
  for (let i = 1; i < samples.length; i++) {
    const same = samples[i].sum === samples[i - 1].sum;
    if (same && runStart === null) runStart = samples[i - 1];
    if (!same && runStart !== null) {
      gaps.push({ startMs: runStart.t, ms: samples[i - 1].t - runStart.t, dark: samples[i - 1].lit <= 0 });
      runStart = null;
    }
  }
  if (runStart !== null) {
    const last = samples[samples.length - 1];
    gaps.push({ startMs: runStart.t, ms: last.t - runStart.t, dark: last.lit <= 0, openEnded: true });
  }

  const t0 = samples[0].t;
  const real = gaps.filter((g) => g.ms >= 400); // one sample interval of slop

  console.log("");
  STEP(`samples: ${samples.length} over ${Math.round((samples[samples.length - 1].t - t0) / 1000)}s`);
  STEP(`renewals logged by the page: ${tokenLog.filter((l) => l.text.includes("renewed")).length}`);
  for (const l of tokenLog) STEP(`  ${l.text.replace(/^\S+\s/, "")}`);

  console.log("");
  if (!real.length) {
    STEP("no stall longer than 400ms — the swap is invisible at this resolution");
  } else {
    STEP(`stalls over 400ms: ${real.length}`);
    for (const g of real) {
      STEP(
        `  at +${((g.startMs - t0) / 1000).toFixed(1)}s  ${Math.round(g.ms)}ms` +
        `${g.dark ? "  (BLACK)" : ""}${g.openEnded ? "  (never recovered)" : ""}`
      );
    }
  }

  const worst = real.reduce((a, g) => Math.max(a, g.ms), 0);
  const neverRecovered = real.some((g) => g.openEnded);

  console.log("");
  if (neverRecovered) {
    console.log(`VERDICT: BROKEN — playback stopped and never resumed. Re-pointing the element\n` +
                `         is not a viable renewal strategy; it needs a second element.\n`);
    process.exitCode = 1;
  } else if (!worst) {
    console.log(`VERDICT: SEAMLESS — renewal caused no measurable interruption.\n`);
  } else if (worst < 1000) {
    console.log(`VERDICT: MINOR — worst stall ${Math.round(worst)}ms. Noticeable as a hitch, not a break.\n`);
  } else {
    console.log(`VERDICT: ROUGH — worst stall ${Math.round(worst)}ms. Viewers would see this.\n`);
  }
} catch (e) {
  console.error(`\nERROR: ${e.message}\n`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
