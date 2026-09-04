// Diagnostic, not a test: prints the stream card's boxes at phone widths so a layout decision
// can be made from measurements instead of from guesses.
//
//   node scripts/e2e/lib/measure-card.mjs [origin]
//
// Needs WF_PUBLISH_KEY and a deployed origin, for the same reason theme-in-stream-card.mjs
// does: the publish-key modal otherwise covers what is being measured.

import puppeteer from "puppeteer";
import { clearSeedGate } from "./seed-gate.mjs";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");
const PK = process.env.WF_PUBLISH_KEY || "";
if (!PK) {
  console.error("measure-card needs WF_PUBLISH_KEY.");
  process.exit(1);
}

const WIDTHS = [320, 360, 375, 390, 430];

const SHOT = () => {
  const px = (n) => Math.round(n * 10) / 10;
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { tag: el.id || el.className || el.tagName, w: px(r.width), l: px(r.left), r: px(r.right), cy: px((r.top + r.bottom) / 2) };
  };
  const vis = (el) => getComputedStyle(el).display !== "none" && el.getClientRects().length > 0;
  const info = document.querySelector(".stream-info");
  const header = document.querySelector(".stream-header");
  const row = document.querySelector(".toggle-row");
  const cs = getComputedStyle(info);
  return {
    card: px(info.getBoundingClientRect().width),
    infoGap: cs.gap,
    headerGap: getComputedStyle(header).gap,
    children: [...info.children].filter(vis).map(box),
    headerKids: [...header.children].filter(vis).map(box),
    rowKids: [...row.children].filter(vis).map(box),
  };
};

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});

for (const w of WIDTHS) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: 844, isMobile: true, hasTouch: true });
  await page.goto(`${ORIGIN}/broadcast?pk=${encodeURIComponent(PK)}`, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });
  await page.waitForSelector("#protect-btn", { timeout: 30000 });
  await clearSeedGate(page);
  const s = await page.evaluate(SHOT);
  console.log(`\n${w}px — card ${s.card}px, .stream-info gap ${s.infoGap}, .stream-header gap ${s.headerGap}`);
  for (const c of s.children) console.log(`   info child  ${String(c.w).padStart(6)}  cy=${String(c.cy).padStart(6)}  ${c.tag}`);
  console.log(`   header:  ${s.headerKids.map((k) => `${k.tag}=${k.w}`).join("  ")}`);
  console.log(`   toggles: ${s.rowKids.map((k) => `${k.tag}=${k.w}`).join("  ")}`);
  const hw = s.headerKids.reduce((a, k) => a + k.w, 0);
  const rw = s.rowKids.reduce((a, k) => a + k.w, 0);
  console.log(`   content: header ${Math.round(hw)} + toggles ${Math.round(rw)} = ${Math.round(hw + rw)} in ${s.card}`);
  await page.close();
}

await browser.close();
