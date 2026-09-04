// What is actually stacked inside <moq-publish> once the camera is on?
//
// Diagnostic for the Edge/Windows report that the camera preview appears and then goes away.
// The preview is our compositor canvas, injected as the element's first child while the
// element's own <video> is hidden. If the element re-renders its light DOM (it is set up
// again on go-live, when `name`/`url` change) that hiding can be undone, and an opaque
// <video> would sit on top of a canvas that is still there and still painting — which every
// geometry/pixel check would call a pass.
//
//   node scripts/e2e/publisher-dom-watch.mjs [origin]
//
// Prints the element's children with their computed display/size/stacking at intervals.

import puppeteer from "puppeteer";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");
const PK = process.env.WF_PUBLISH_KEY || "";
const URL = `${ORIGIN}/broadcast${PK ? `?pk=${encodeURIComponent(PK)}` : ""}`;

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const DUMP = () => {
  const p = document.querySelector("moq-publish");
  if (!p) return { error: "no moq-publish" };
  const kids = [...p.children].map((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      cls: el.className || "",
      display: cs.display,
      vis: cs.visibility,
      opacity: cs.opacity,
      pos: cs.position,
      z: cs.zIndex,
      rect: `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)}`,
      hasSrc: el.tagName === "VIDEO" ? !!el.srcObject : undefined,
    };
  });
  // Who would receive a click at the centre of the publisher box — i.e. who is on top.
  const r = p.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return {
    kids,
    topmost: top ? `${top.tagName.toLowerCase()}.${top.className || ""}` : "none",
  };
};

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`  [console error] ${m.text()}`);
  });
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector("button.toggle-btn", { timeout: 30000 });

  console.log("  before click:", JSON.stringify(await page.evaluate(DUMP), null, 1));

  await page.evaluate(() => {
    [...document.querySelectorAll("button.toggle-btn")]
      .find((x) => (x.title || "").toLowerCase().startsWith("camera"))
      ?.click();
  });

  for (const t of [1, 3, 6, 10, 15]) {
    await new Promise((r) => setTimeout(r, t === 1 ? 1000 : 2000));
    console.log(`\n  t≈${t}s:`, JSON.stringify(await page.evaluate(DUMP), null, 1));
  }
} finally {
  await browser.close();
}
