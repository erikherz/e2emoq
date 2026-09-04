// The stream header, after it was stripped to two controls on 2026-08-30.
//
//   WF_PUBLISH_KEY=<code> node scripts/e2e/link-bar.mjs [origin]
//
// It used to carry six things: an Encrypted shield, a stream icon, the visible stream id, Copy,
// New-link, and the audience count. Four left. What is asserted here is not "the row looks
// tidy" — it is the two things that removal could break quietly.
//
// 1. THE ID IS STILL IN THE DOM. It is .sr-only, not deleted, because currentStreamId() in
//    seeds-client.ts reads it to learn which stream is live: on /broadcast the URL path carries
//    no id, so that element is its only source. Delete it and seed attribution stops working
//    with no error anywhere — the page looks perfect and the burn goes to nothing. This checks
//    the element is present, invisible, and actually holds five characters.
//
// 2. COPY STILL REPORTS FAILURE HONESTLY. Copy is now the ONLY way to obtain the share link,
//    and it is gold rather than grey to say so. Gold is set on #copy-btn, which is an id and
//    therefore outranks the .copy-icon-btn.copied / .copy-failed classes that colour the
//    result — so without id-strength rules for those two states, a refused clipboard write
//    would render exactly like a successful one and like resting. That is the failure this
//    codebase already learned the hard way with the unconditional checkmark: a broadcaster
//    pastes the wrong thing and finds out when nobody can watch.
//
//    Which of the two paths runs here is not fixed. A focused headless page is usually granted
//    the clipboard, so it is normally the SUCCESS path — a note elsewhere in this suite claiming
//    headless always refuses is simply wrong. Both outcomes pass; what is asserted is that they
//    stay distinguishable from each other and from resting gold.
//
// Also checks the four removed things stay removed, since each was deleted for a reason worth
// not reversing by accident.

import puppeteer from "puppeteer";
import { clearSeedGate } from "./lib/seed-gate.mjs";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");
const PK = process.env.WF_PUBLISH_KEY || "";
if (!PK) {
  console.error("link-bar needs WF_PUBLISH_KEY — without it the publish-key modal covers the row.");
  process.exit(1);
}

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) {
    failures.push(name);
    process.exitCode = 1;
  }
};

const rgb = (s) => (s.match(/\d+/g) || []).slice(0, 3).map(Number);
const near = (a, b, tol = 12) => a.length === 3 && a.every((v, i) => Math.abs(v - b[i]) <= tol);

let completed = false;
const browser = await puppeteer.launch({ headless: "new" });

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 430, height: 900, isMobile: true, hasTouch: true });
  await page.goto(`${ORIGIN}/broadcast?pk=${encodeURIComponent(PK)}`, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });
  await page.waitForSelector("#copy-btn", { timeout: 30000 });
  await clearSeedGate(page);

  console.log("\nthe link bar\n");

  const s = await page.evaluate(() => {
    const header = document.querySelector(".stream-header");
    // .sr-only clips to a 1px box rather than leaving the render tree, so it still has a client
    // rect. Width is what decides whether something occupies the row.
    const shown = [...header.children].filter((c) => c.getBoundingClientRect().width > 1);
    const id = document.getElementById("stream-id");
    const copy = document.getElementById("copy-btn");
    const cs = getComputedStyle(copy);
    return {
      visible: shown.map((c) => c.id || c.className),
      idPresent: !!id,
      idWidth: id ? id.getBoundingClientRect().width : -1,
      idText: id?.textContent?.trim() ?? "",
      shield: !!header.querySelector(".relay-blind-badge"),
      label: !!header.querySelector(".stream-label"),
      newid: !!document.getElementById("newid-btn"),
      caret: !!document.querySelector(".vs-caret"),
      eye: !!document.querySelector("#viewer-stats-toggle .vs-label svg"),
      colour: cs.color,
      svg: parseFloat(getComputedStyle(copy.querySelector("svg")).width),
      share: copy.getAttribute("data-share-url") ?? "",
    };
  });

  check("the shield is gone", !s.shield);
  check("the stream icon is gone", !s.label);
  check("the New-link button is gone", !s.newid);
  check("the caret beside the count is gone", !s.caret);
  check("the eye itself stays", s.eye);
  check(
    "two visible controls remain: Copy and the audience count",
    s.visible.length === 2 && s.visible[0] === "copy-btn" && s.visible[1] === "viewer-stats-toggle",
    s.visible.join(" + ") || "(none)"
  );

  // The id: present, invisible, and real. Any one of the three failing breaks seed attribution
  // or puts the id back on screen.
  check("the stream id is still in the DOM for the seeds client", s.idPresent);
  check("but takes no space in the row", s.idWidth >= 0 && s.idWidth <= 1, `${s.idWidth}px`);
  check("and carries a real five-character id", /^[a-z0-9]{5}$/.test(s.idText), s.idText || "(empty)");

  // Gold and bigger. Measured, not asserted from the stylesheet — a rule that loses to another
  // rule is still in the stylesheet.
  check("Copy is gold, not grey", near(rgb(s.colour), [212, 160, 23]) || near(rgb(s.colour), [161, 98, 7]), s.colour);
  check("and larger than the 16px icons it used to match", s.svg >= 20, `${s.svg}px`);
  check("it still carries the whole share link, fragment included", /#k=/.test(s.share));

  // Whether the clipboard write succeeds here depends on the run: a focused headless page with
  // no permission prompt is usually granted it, so this reaches the SUCCESS path more often
  // than not. Both outcomes are acceptable; what must never happen is that they look the same
  // as each other or the same as resting, which is exactly what #copy-btn's gold would cause
  // if the state rules were left at class strength.
  await page.click("#copy-btn");
  await new Promise((r) => setTimeout(r, 400));
  const after = await page.evaluate(() => {
    const copy = document.getElementById("copy-btn");
    const fb = document.querySelector(".share-fallback");
    return {
      cls: copy.className,
      colour: getComputedStyle(copy).color,
      fallbackShown: !!fb && !fb.classList.contains("hidden"),
      fallbackValue: fb?.value ?? "",
    };
  });
  const ok = /\bcopied\b/.test(after.cls);
  const failed = /copy-failed/.test(after.cls);
  check("the click is reported as one outcome or the other", ok !== failed, after.cls);
  check(
    "and that outcome is not resting gold — the id rule beats the state class without it",
    (ok || failed) && !near(rgb(after.colour), rgb(s.colour)),
    after.colour
  );
  check(
    ok ? "success shows the green tick" : "failure hands over the whole link to copy by hand",
    ok ? near(rgb(after.colour), [34, 197, 94]) : after.fallbackShown && /#k=/.test(after.fallbackValue),
    ok ? after.colour : after.fallbackValue.slice(0, 40)
  );

  completed = true;
} finally {
  await browser.close();
  if (!completed) {
    process.exitCode = 1;
    console.log("\nFAIL: the run did not finish — see the error above.");
  }
  console.log(
    completed && failures.length === 0
      ? "\nPASS: two controls, the id still readable by the seeds client and by nothing else, " +
        "and Copy's result still legible against its gold."
      : failures.length
        ? `\nFAIL: ${failures.length} check(s) failed.`
        : ""
  );
}
