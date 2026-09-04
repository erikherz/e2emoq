// The Link watermark's controls, against a DEPLOYED origin.
//
//   node scripts/e2e/link-ui.mjs [origin]
//
// Two things this pins that nothing else does:
//
//  1. Link is present, labelled, and where it belongs in the row. The QR is encoded and drawn
//     by code that unit tests cover thoroughly, but none of that helps if the button that
//     reaches it never rendered.
//  2. Extras is BUILT BUT UNREACHABLE. That is a deliberate middle state, not a step someone
//     forgot to finish: the editor, sanitiser and viewer render path all still work so that
//     streams already using it keep rendering, while nothing new can be authored. Both halves
//     are asserted, because "hidden" silently becoming "deleted" — or coming back — are both
//     regressions, and neither would be obvious.
import puppeteer from "puppeteer";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");
const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });

let fails = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
};

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${ORIGIN}/broadcast`, { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2500)); // the bar is built after settings load

  const m = await page.evaluate(() => {
    const vis = (el) => {
      if (!el) return false;
      const s = getComputedStyle(el);
      return s.display !== "none" && s.visibility !== "hidden" && el.getBoundingClientRect().width > 0;
    };
    const link = document.querySelector("#link-btn");
    const extras = document.querySelector(".html-overlay-btn");
    const bar = document.querySelector(".publish-controls");
    return {
      linkExists: !!link,
      linkVisible: vis(link),
      linkLabel: link?.querySelector(".btn-label")?.textContent ?? null,
      linkTitle: link?.title ?? null,
      linkHasSvg: !!link?.querySelector("svg"),
      extrasExists: !!extras,
      extrasVisible: vis(extras),
      editorVisible: vis(document.querySelector(".html-overlay-container")),
      order: bar
        ? [...bar.querySelectorAll(".publish-btn")].filter(vis).map((b) => b.querySelector(".btn-label")?.textContent)
        : [],
    };
  });

  console.log("\n  the Link control\n");
  check("it is in the control bar", m.linkExists);
  check("it is visible", m.linkVisible);
  check("it is labelled 'Link'", m.linkLabel === "Link", JSON.stringify(m.linkLabel));
  check("it carries a QR glyph", m.linkHasSvg);
  // The tooltip is the only place both halves of the feature are named. If it stops mentioning
  // the tappable copy, a broadcaster has no way to learn it exists.
  check("its tooltip names the QR and the tappable link",
    /QR code/.test(m.linkTitle ?? "") && /tappable/.test(m.linkTitle ?? ""), m.linkTitle ?? "");

  console.log("\n  Extras: hidden, deliberately not removed\n");
  check("it is still built", m.extrasExists);
  check("...but cannot be seen", !m.extrasVisible);
  check("...and its editor cannot be reached", !m.editorVisible);

  console.log("\n  the row\n");
  const WANT = ["Camera", "Audio", "Screen", "Location", "Handle", "Link", "Chat"];
  check("reads as expected, with Link where Extras used to be",
    JSON.stringify(m.order) === JSON.stringify(WANT), JSON.stringify(m.order));
} finally {
  await browser.close();
}

console.log(fails ? `\n${fails} FAILURES` : "\nall link UI checks passed");
process.exit(fails ? 1 : 0);
