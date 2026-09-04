// Day/night lives in the site header everywhere EXCEPT a broadcaster's own page, where it is
// moved into the stream card immediately left of Protect.
//
//   node scripts/e2e/theme-in-stream-card.mjs [origin]
//
// Needs WF_PUBLISH_KEY and a deployed origin: without a key the broadcast page raises the
// publish-key modal over the card, and the control this file is about would be measured
// underneath it.
//
// The button is MOVED, not copied — one element, carrying the listener initTheme() attached by
// id. Three things follow from that, and each is a way this could break silently:
//
//   1. EXACTLY ONE on the page. A refactor that renders a second copy instead of relocating the
//      first gives the broadcast page two theme buttons, and only one of them would have the
//      listener — the dead one being whichever the id lookup missed.
//   2. STILL CLICKABLE AFTER THE MOVE. Moving a node preserves its listeners, but nothing in
//      the language guarantees the code keeps doing it that way; a future version that clones,
//      or re-renders the header, would leave a button that looks right and does nothing. So
//      this clicks it and reads the class it is supposed to toggle.
//   3. STILL IN THE HEADER ELSEWHERE. The landing page has no stream card, and a visitor there
//      has no other way to change the theme.
//
// It also measures the row, because the stream card is the one place in this UI where fitting
// on a phone was already tight — index.html shaves gaps under 430px for no other reason. Adding
// this control cost 26.5px at 390px and the gaps were retuned to pay for it, so the card holds
// one line at 375, 390 and 430; 360 and 320 wrap.
//
// Each width prints its row count WITH the button and, from the same page with the button
// removed, WITHOUT it — an A/B rather than a remembered number, which would go stale the moment
// anything else joins the row. Wrapping is NOT failed here: the card is flex-wrap:wrap on
// purpose and a second line costs nothing but height. Sideways page scroll is failed, and so is
// a card whose content is wider than the card.

import puppeteer from "puppeteer";
import { clearSeedGate } from "./lib/seed-gate.mjs";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");
const PK = process.env.WF_PUBLISH_KEY || "";

if (!PK) {
  console.error(
    "theme-in-stream-card needs WF_PUBLISH_KEY. Without it the publish-key modal covers the\n" +
    "stream card, and every measurement below would be taken through it."
  );
  process.exit(1);
}

// Portrait widths of phones people actually hold, narrowest first.
const WIDTHS = [320, 360, 375, 390, 430];

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) {
    failures.push(name);
    process.exitCode = 1;
  }
};

// Rows of .stream-info grouped by vertical centre rather than by top: the children are
// different heights and are centre-aligned, so grouping on top would report every layout as
// wrapped.
const MEASURE = () => {
  const t = document.getElementById("theme-toggle");
  const p = document.getElementById("protect-btn");
  const info = document.querySelector(".stream-info");
  const kids = [...info.children].filter(
    (c) => getComputedStyle(c).display !== "none" && c.getClientRects().length > 0
  );
  const rows = [];
  for (const c of kids) {
    const r = c.getBoundingClientRect();
    const cy = (r.top + r.bottom) / 2;
    let row = rows.find((x) => Math.abs(x.cy - cy) < 12);
    if (!row) rows.push((row = { cy, left: Infinity, right: -Infinity }));
    row.left = Math.min(row.left, r.left);
    row.right = Math.max(row.right, r.right);
  }
  const tr = t?.getBoundingClientRect();
  const pr = p?.getBoundingClientRect();
  return {
    count: document.querySelectorAll("#theme-toggle").length,
    inHeader: !!t?.closest("header"),
    beforeProtect: !!t && p?.previousElementSibling === t,
    shown: !!t && t.getClientRects().length > 0,
    h: tr ? Math.round(tr.height) : 0,
    protectH: pr ? Math.round(pr.height) : 0,
    tap: tr ? Math.round(Math.min(tr.width, tr.height)) : 0,
    rows: rows.length,
    widest: Math.round(Math.max(...rows.map((r) => r.right - r.left))),
    card: Math.round(info.getBoundingClientRect().width),
    sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
};

let completed = false;
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});

const open = async (path, width) => {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 844, isMobile: width < 700, hasTouch: width < 700 });
  await page.goto(`${ORIGIN}${path}`, { waitUntil: "networkidle2", timeout: 60000 });
  return page;
};

try {
  // ══ BROADCAST ═══════════════════════════════════════════════════════════════════════
  console.log("\nbroadcast page — the control moves into the stream card\n");
  const b = await open(`/broadcast?pk=${encodeURIComponent(PK)}`, 390);
  await b.waitForSelector("#protect-btn", { timeout: 30000 });
  // The free-seed overlay is z-index 10000 across the whole viewport and swallows a real
  // click without a trace. See lib/seed-gate.mjs.
  await clearSeedGate(b, (m) => console.log(`  .. ${m}`));

  const m = await b.evaluate(MEASURE);
  check("exactly one theme control on the page", m.count === 1, `found ${m.count}`);
  check("it is no longer in the site header", !m.inHeader);
  check("it sits immediately left of Protect", m.beforeProtect);
  check("it renders", m.shown);
  check(
    "it is the same height as Protect, so it belongs to that row",
    m.protectH > 0 && Math.abs(m.h - m.protectH) <= 2,
    `${m.h}px vs ${m.protectH}px`
  );

  // The listener came with the element. Prove it rather than assume it.
  const before = await b.evaluate(() => document.documentElement.classList.contains("light"));
  await b.click("#theme-toggle");
  const after = await b.evaluate(() => ({
    light: document.documentElement.classList.contains("light"),
    saved: localStorage.getItem("theme"),
  }));
  check("clicking it still switches the theme", after.light !== before, `light ${before} → ${after.light}`);
  check("and still records the choice", after.saved === (after.light ? "light" : "dark"), String(after.saved));
  await b.close();

  // ══ LANDING ═════════════════════════════════════════════════════════════════════════
  console.log("\nlanding page — the header keeps it\n");
  const l = await open("/", 390);
  await l.waitForSelector("header", { timeout: 30000 });
  const lm = await l.evaluate(() => {
    const t = document.getElementById("theme-toggle");
    return {
      count: document.querySelectorAll("#theme-toggle").length,
      inHeader: !!t?.closest("header"),
      shown: !!t && t.getClientRects().length > 0,
    };
  });
  check("exactly one theme control", lm.count === 1, `found ${lm.count}`);
  check("in the header", lm.inHeader);
  check("and visible — nothing else here offers the theme", lm.shown);
  await l.close();

  // ══ THE ROW ON A PHONE ══════════════════════════════════════════════════════════════
  console.log("\nthe stream card at phone widths (a second line is allowed; sideways scroll is not)\n");
  for (const w of WIDTHS) {
    const p = await open(`/broadcast?pk=${encodeURIComponent(PK)}`, w);
    await p.waitForSelector("#protect-btn", { timeout: 30000 });
    const r = await p.evaluate(MEASURE);
    // A/B on the same page: how the card laid out BEFORE this button existed. Comparing
    // against a remembered number would go stale the moment anything else joins the row.
    const without = await p.evaluate(() => {
      const t = document.getElementById("theme-toggle");
      const parent = t.parentElement, next = t.nextElementSibling;
      t.remove();
      const info = document.querySelector(".stream-info");
      const kids = [...info.children].filter(
        (c) => getComputedStyle(c).display !== "none" && c.getClientRects().length > 0
      );
      const rows = [];
      for (const c of kids) {
        const r = c.getBoundingClientRect();
        const cy = (r.top + r.bottom) / 2;
        let row = rows.find((x) => Math.abs(x.cy - cy) < 12);
        if (!row) rows.push((row = { cy }));
      }
      parent.insertBefore(t, next);
      return rows.length;
    });
    check(
      `${w}px`,
      !r.sideways && r.widest <= r.card && r.shown,
      `${r.rows} row(s) (${without} without it), widest ${r.widest}px in ${r.card}px, tap ${r.tap}px` +
        (r.sideways ? "  — THE PAGE SCROLLS SIDEWAYS" : "") +
        (r.widest > r.card ? "  — THE CARD OVERFLOWS" : "") +
        (!r.shown ? "  — THE CONTROL IS NOT VISIBLE" : "")
    );
    await p.close();
  }

  completed = true;
} finally {
  await browser.close();
  if (!completed) {
    process.exitCode = 1;
    console.log("\nFAIL: the run did not finish — see the error above.");
  }
  console.log(
    completed && failures.length === 0
      ? "\nPASS: one control, beside Protect on a broadcaster's page, in the header everywhere " +
        "else, still wired, and the card holds together down to 320px."
      : failures.length
        ? `\nFAIL: ${failures.length} check(s) failed.`
        : ""
  );
}
