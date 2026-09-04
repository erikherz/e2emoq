// The @handle watermark, checked on the deployed site.
//
//   WF_PUBLISH_KEY=<code> node scripts/e2e/handle-watermark.mjs [origin]
//
// Like the location burn-in, this has to reach the COMPOSITED CANVAS — that canvas is what
// gets encoded, so a DOM check would prove nothing about what viewers see. Sampling the upper
// left before and after is the only assertion that means anything.

import puppeteer from "puppeteer";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");
const PK = process.env.WF_PUBLISH_KEY || "";
if (!PK) {
  console.error("WF_PUBLISH_KEY is required");
  process.exit(1);
}

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};
const note = (m) => console.log(`  --    ${m}`);

const HANDLE = "e2e-watermark";

// Fraction of "bright" pixels in the upper-left corner where the watermark sits. The threshold
// is 120 rather than 200 because the watermark is deliberately semi-transparent (0.62 white),
// so over a dark frame it lands around mid-grey — a near-white test would miss it entirely and
// report a working feature as broken.
const cornerBright = () => {
  const c = document.querySelector("canvas.pip-canvas");
  if (!c || c.width < 640) return null;
  const W = 420;
  const H = 70;
  const probe = document.createElement("canvas");
  probe.width = W;
  probe.height = H;
  const x = probe.getContext("2d", { willReadFrequently: true });
  x.drawImage(c, 0, 0, W, H, 0, 0, W, H);
  const d = x.getImageData(0, 0, W, H).data;
  let bright = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] > 120 && d[i + 1] > 120 && d[i + 2] > 120) bright++;
  }
  return bright / (d.length / 4);
};

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});

console.log(`\n@handle watermark @ ${ORIGIN}\n`);

try {
  const page = await browser.newPage();
  let lastPrompt = null;
  page.on("dialog", (d) => {
    lastPrompt = { message: d.message(), defaultValue: d.defaultValue() };
    void d.accept(HANDLE);
  });

  await page.goto(`${ORIGIN}/broadcast?pk=${encodeURIComponent(PK)}`, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector("#handle-btn", { timeout: 20000 });
  check("the @ button is in the control bar", true, true);
  check("it starts off", await page.evaluate(() => document.getElementById("handle-btn").classList.contains("toggle-on")), false);

  // Camera first, so there is a composite to draw onto.
  await page.evaluate(() => document.querySelector('.publish-btn.toggle-btn[title^="Camera"]').click());
  await page.waitForFunction(() => {
    const c = document.querySelector("canvas.pip-canvas");
    return c && c.width >= 640;
  }, { timeout: 30000, polling: 300 });
  // Let real frames land, so "before" measures the picture and not an empty canvas.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 3000)));

  const before = await page.evaluate(cornerBright);
  note(`corner before: bright ${(before * 100).toFixed(2)}%`);

  await page.click("#handle-btn");
  await page.waitForFunction(() => document.getElementById("handle-btn").classList.contains("toggle-on"), { timeout: 15000 });
  check("entering a handle turns it on", true, true);
  check("it asked for a handle", /handle/i.test(lastPrompt?.message || ""), true);

  await page.evaluate(() => new Promise((r) => setTimeout(r, 800)));
  const on = await page.evaluate(cornerBright);
  note(`corner on:     bright ${(on * 100).toFixed(2)}%`);
  check("the watermark appears in the upper left of the composite", on > before + 0.005, true);

  // Off must actually clear it, not just un-light the button.
  await page.click("#handle-btn");
  await page.waitForFunction(() => !document.getElementById("handle-btn").classList.contains("toggle-on"), { timeout: 10000 });
  await page.evaluate(() => new Promise((r) => setTimeout(r, 800)));
  const off = await page.evaluate(cornerBright);
  note(`corner off:    bright ${(off * 100).toFixed(2)}%`);
  check("turning it off clears the watermark", off < before + 0.005, true);

  // The handle is remembered per device, so the next broadcast is one Enter rather than a
  // retype. Prove it survives a reload rather than living in a closure.
  lastPrompt = null;
  await page.reload({ waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector("#handle-btn", { timeout: 20000 });
  await page.click("#handle-btn");
  await page.waitForFunction(() => document.getElementById("handle-btn").classList.contains("toggle-on"), { timeout: 15000 });
  check("the handle is remembered and prefilled", lastPrompt?.defaultValue, HANDLE);

  // Leave nothing behind on the shared test profile.
  await page.evaluate(() => { try { localStorage.removeItem("e2emoq.handle"); } catch { /* ignore */ } });
  // No Stop button — turning the live inputs off is what ends a broadcast.
  await page.evaluate(() => {
    document.querySelectorAll(".publish-btn.toggle-btn.toggle-on").forEach((b) => b.click());
  });
  await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} failed\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
