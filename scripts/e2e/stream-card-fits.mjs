// The stream card has to fit on a phone in portrait.
//
//   node scripts/e2e/stream-card-fits.mjs
//
// Reported from a real iPhone: the card carrying the stream id, the audience count and Protect
// wrapped. Three text labels — "Stream:", "watching", "Protect" — were most of its width, and
// they are now icons. This measures that rather than trusting it.
//
// Like control-bar-fits, it needs no key, no relay and no deploy: it lifts the REAL stylesheet
// and the REAL .stream-info markup out of dist/index.html and measures it.
//
// It used to inject two things main.ts added at runtime. Both are gone as of 2026-08-30: the
// shield is no longer prepended here (it lives on the watch page now), and the id is .sr-only,
// so the five characters it becomes take no space in the row. Nothing is injected any more —
// what the built page contains is what a broadcaster gets.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BUILT = path.join(ROOT, "dist/index.html");
if (!fs.existsSync(BUILT)) {
  console.error("dist/index.html is missing — run `npm run build` first.");
  process.exit(1);
}
const html = fs.readFileSync(BUILT, "utf8");
const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");

// Pull the real card out by balancing <div> tags from the opening one. Regex alone cannot do
// this — the card contains nested divs — and hand-copying the markup here is what let
// control-bar-fits drift from what main.ts actually emits.
function extractCard(src) {
  const start = src.indexOf('<div class="stream-info">');
  if (start < 0) return null;
  let depth = 0;
  const re = /<\/?div\b[^>]*>/g;
  re.lastIndex = start;
  for (let m; (m = re.exec(src)); ) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return src.slice(start, m.index + m[0].length);
  }
  return null;
}

const card = extractCard(html);
if (!card || !styles.includes(".stream-info")) {
  console.error("could not find the stream card or its CSS in the built page");
  process.exit(1);
}

// The id still becomes five characters at runtime. It is .sr-only and contributes no width,
// but substituting it keeps the fixture honest about what is in the DOM — and would show up
// here as a sudden jump in the row if it were ever made visible again.
const LIVE = card.replace(">loading...<", ">2xz9l<");

const DEVICES = [
  ["iPhone SE / 12 mini", 375],
  ["iPhone 14 / 15", 390],
  ["iPhone 14 Pro", 393],
  ["iPhone 16 Pro", 402],
  ["iPhone 15 Pro Max", 430],
];

let failures = 0;
const check = (ok, line) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${line}`);
};

const browser = await puppeteer.launch({ headless: "new" });
try {
  const page = await browser.newPage();
  console.log("\nstream card, portrait\n");

  for (const [name, width] of DEVICES) {
    await page.setViewport({ width, height: 800, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    await page.setContent(
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<style>${styles}</style><div class="container">${LIVE}</div>`,
      { waitUntil: "load" }
    );

    const m = await page.evaluate(() => {
      const vis = (el) => getComputedStyle(el).display !== "none";
      // Count distinct lines by vertical centre — the icons and the id are different heights,
      // so grouping on `top` would report a wrap that is not there.
      const rows = (el) => {
        const kids = [...el.children].filter(vis);
        const lines = [];
        for (const k of kids) {
          const r = k.getBoundingClientRect();
          const cy = r.top + r.height / 2;
          if (!lines.some((l) => Math.abs(l - cy) < 8)) lines.push(cy);
        }
        return lines.length;
      };
      const info = document.querySelector(".stream-info");
      const header = document.querySelector(".stream-header");
      const toggle = document.querySelector(".toggle-row");
      const h = header.getBoundingClientRect();
      const t = toggle.getBoundingClientRect();
      return {
        headerRows: rows(header),
        // Do the id row and Protect share a line, or has Protect been pushed below it?
        sameLine: Math.abs(h.top + h.height / 2 - (t.top + t.height / 2)) < 8,
        needed: Math.round(h.width + t.width),
        available: Math.round(info.clientWidth - 32), // minus the card's 1rem side padding
        scrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });

    const ok = m.headerRows === 1 && !m.scrolls;
    check(
      ok,
      `${name} (${width}px): id row on ${m.headerRows} line(s), ` +
        `Protect ${m.sameLine ? "beside it" : "below it"}, ` +
        `content ${m.needed}px in ${m.available}px` +
        (m.headerRows > 1 ? "  — THE ID ROW WRAPS" : "") +
        (m.scrolls ? "  — THE PAGE SCROLLS SIDEWAYS" : "")
    );
  }
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} failed\n` : "\nthe card holds on every phone tested\n");
process.exit(failures ? 1 : 0);
