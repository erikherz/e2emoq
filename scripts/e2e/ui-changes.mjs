// The footer / passcode / "How it works" UI changes, checked on the deployed site.
//   WF_PUBLISH_KEY=<key> node scripts/e2e/ui-changes.mjs [origin]

import puppeteer from "puppeteer";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");
const PK = process.env.WF_PUBLISH_KEY || "";

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});

try {
  const page = await browser.newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: "networkidle2", timeout: 60000 });

  console.log(`\nfooter + landing @ ${ORIGIN}\n`);

  const footer = await page.evaluate(() => document.querySelector("footer")?.innerText ?? "");
  check("TinyMoQ is gone from the footer", /tinymoq/i.test(footer), false);
  check("How it works is in the footer", /how it works/i.test(footer), true);

  // The panel must start closed and open on click — a link that reveals nothing is worse
  // than the section it replaced.
  check("the panel starts hidden", await page.evaluate(() => document.getElementById("howitworks-panel")?.classList.contains("hidden")), true);

  // The footer is revealed by the app's own init, not by the served HTML, so networkidle is
  // not enough — wait for the link to actually have a box before clicking it.
  await page.waitForFunction(
    () => (document.getElementById("howitworks-link")?.getBoundingClientRect().width ?? 0) > 0,
    { timeout: 15000 }
  );
  check("the link is reachable on the landing page", true, true);
  await page.click("#howitworks-link");
  const opened = await page.evaluate(() => {
    const p = document.getElementById("howitworks-panel");
    return { shown: !p?.classList.contains("hidden"), text: p?.innerText ?? "" };
  });
  check("clicking reveals it", opened.shown, true);
  check("it still explains the key never reaches us", /never reaches us/i.test(opened.text), true);
  check("the landing page no longer duplicates it", await page.evaluate(
    () => [...document.querySelectorAll(".promo-heading")].some((h) => /how it works/i.test(h.textContent))
  ), false);

  check("the Watch nav link is gone", await page.evaluate(() => !!document.getElementById("nav-watch")), false);

  // /watch had a dialler form that could not succeed: a bare stream id carries no key and no
  // longer yields a token, and a pasted share link was rejected as invalid. An old bookmark
  // should land somewhere usable rather than on a form that always fails.
  await page.goto(`${ORIGIN}/watch`, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForFunction(
    () => (document.getElementById("howitworks-link")?.getBoundingClientRect().width ?? 0) > 0,
    { timeout: 15000 }
  );
  const watchPage = await page.evaluate(() => ({
    footer: document.querySelector("footer")?.innerText ?? "",
    hasEntryForm: !!document.getElementById("watch-entry-input"),
    landingShown: !document.getElementById("landing-view")?.classList.contains("hidden"),
  }));
  check("/watch: the dead entry form is gone", watchPage.hasEntryForm, false);
  check("/watch: lands on the landing view", watchPage.landingShown, true);
  check("/watch: no TinyMoQ in the footer", /tinymoq/i.test(watchPage.footer), false);
  check("/watch: How it works present", /how it works/i.test(watchPage.footer), true);

  // ── Passcode box, which only exists once broadcasting ──────────────────────────────────
  console.log("");
  const bc = await browser.newPage();
  await bc.goto(`${ORIGIN}/broadcast${PK ? `?pk=${encodeURIComponent(PK)}` : ""}`, { waitUntil: "networkidle2", timeout: 60000 });
  await bc.waitForSelector('button.publish-btn[title="Camera"]', { timeout: 30000 });
  await bc.click('button.publish-btn[title="Camera"]');
  await bc.waitForFunction(() => /[?&]stream=[a-z0-9]{5}/.test(location.href), { timeout: 30000 });

  const bcFooter = await bc.evaluate(() => document.querySelector("footer")?.innerText ?? "");
  check("broadcast view: no TinyMoQ", /tinymoq/i.test(bcFooter), false);

  // Mandatory now: the row populates with no interaction and the checkbox that gated it is
  // gone. A protection nobody switches on protects nobody.
  await bc.waitForFunction(
    () => (document.getElementById("passcode-value")?.textContent || "").length === 8,
    { timeout: 20000 }
  );
  check("the passcode row shows without being switched on",
    await bc.evaluate(() => !document.getElementById("passcode-box")?.classList.contains("hidden")), true);
  check("the passcode checkbox is gone",
    await bc.evaluate(() => !!document.getElementById("passcode-checkbox")), false);
  check("the share link always signals a passcode",
    await bc.evaluate(() => /[#&]p=1/.test(document.getElementById("copy-btn")?.getAttribute("data-share-url") || "")), true);

  // The guidance and the security disclosure are collapsed behind the ⓘ button now, so the
  // control bar stays a control bar. Assert it starts CLOSED, opens on click with both pieces
  // of prose inside, and closes again — a disclosure that cannot be dismissed is a banner.
  const collapsed = await bc.evaluate(() => ({
    hasInfo: !!document.getElementById("passcode-info"),
    panelOpen: !document.getElementById("passcode-hint")?.classList.contains("hidden"),
    expanded: document.getElementById("passcode-info")?.getAttribute("aria-expanded"),
    strayLink: !!document.querySelector(".toggle-row .security-details"),
  }));
  check("an info control exists", collapsed.hasInfo, true);
  check("the panel starts collapsed", collapsed.panelOpen, false);
  check("it reports its state to assistive tech", collapsed.expanded, "false");
  check("the old Security details link is gone from the row", collapsed.strayLink, false);

  await bc.click("#passcode-info");
  await new Promise((r) => setTimeout(r, 300));

  const box = await bc.evaluate(() => {
    const b = document.getElementById("passcode-box");
    const h = document.getElementById("passcode-hint");
    return {
      text: `${b?.innerText ?? ""}\n${h?.innerText ?? ""}`,
      hasCopy: !!document.getElementById("passcode-copy"),
      hasNew: !!document.getElementById("passcode-new"),
      value: document.getElementById("passcode-value")?.textContent ?? "",
      panelOpen: !h?.classList.contains("hidden"),
      expanded: document.getElementById("passcode-info")?.getAttribute("aria-expanded"),
      hasSecurityBody: !!h?.querySelector(".security-body"),
    };
  });
  check("clicking info opens the panel", box.panelOpen, true);
  check("the open state is reported too", box.expanded, "true");
  check("the security disclosure moved inside it", box.hasSecurityBody, true);
  check("it still covers what encryption does not do", /not drm/i.test(box.text), true);

  await bc.click("#passcode-info");
  await new Promise((r) => setTimeout(r, 300));
  check(
    "clicking again collapses it",
    await bc.evaluate(() => document.getElementById("passcode-hint")?.classList.contains("hidden")),
    true
  );
  // Reopen so the prose assertions below read a visible panel.
  await bc.click("#passcode-info");
  await new Promise((r) => setTimeout(r, 300));
  check("a passcode was generated", box.value.length >= 8, true);
  check("a Copy button exists", box.hasCopy, true);
  check("the New button is still there", box.hasNew, true);
  check("the 'say it aloud' sentence is gone", /say it aloud/i.test(box.text), false);
  check("the 'link alone is not enough' sentence is gone", /link alone is not enough/i.test(box.text), false);
  check("the re-key warning survives", /re-keys the stream/i.test(box.text), true);

  // The clipboard itself is NOT assertable here. Headless Chrome refuses writeText even with
  // permissions granted and the page brought to front — the same limitation the share-link
  // copy button documents ("unreadable to anything that is not a focused browser window").
  // So this checks the two things that ARE observable: the click is acknowledged, and when the
  // clipboard is unavailable the passcode is selected so a user can still copy it by hand.
  //
  // That refusal is useful rather than merely inconvenient: it means this run exercises the
  // FAILURE path of both copy buttons, which is the path where a dishonest control does its
  // damage. The share-link button is asserted the same way further down.
  const ctx = browser.defaultBrowserContext();
  await ctx.overridePermissions(ORIGIN, ["clipboard-read", "clipboard-write"]);
  await bc.bringToFront();
  await bc.click("#passcode-copy");
  await new Promise((r) => setTimeout(r, 600));

  // The control is an icon button now, so it reports through `title` and a `.copied` class
  // rather than by replacing its own text — writing text into it would delete the <svg>.
  // That is the contract asserted here, and it is the reason it is asserted at all.
  const after = await bc.evaluate(() => ({
    label: document.getElementById("passcode-copy")?.getAttribute("title") ?? "",
    marked: !!document.getElementById("passcode-copy")?.classList.contains("copied"),
    svg: !!document.getElementById("passcode-copy")?.querySelector("svg"),
    selected: (window.getSelection()?.toString() ?? "").trim(),
  }));
  check("the click is acknowledged", ["Copied", "Select & copy"].includes(after.label), true);
  check("the acknowledgement is also visual", after.marked, true);
  check("the icon survived the acknowledgement", after.svg, true);
  if (after.label === "Select & copy") {
    check("the fallback selects the passcode for manual copying", after.selected, box.value);
    console.log("  note  clipboard write refused (headless); measured the fallback path");
  } else {
    const clip = await bc.evaluate(() => navigator.clipboard.readText().catch(() => "<denied>"));
    check("the clipboard holds the passcode", clip, box.value);
  }

  // The title must return so the control does not look stuck.
  await new Promise((r) => setTimeout(r, 1600));
  const reset = await bc.evaluate(() => ({
    label: document.getElementById("passcode-copy")?.getAttribute("title") ?? "",
    marked: !!document.getElementById("passcode-copy")?.classList.contains("copied"),
  }));
  check("the label resets", /copy passcode/i.test(reset.label), true);
  check("the copied mark clears", reset.marked, false);

  // The new-link control was removed from the stream header on 2026-08-30 and the four checks
  // that described it went with it. rotateIdentity() survives as the 409 conflict recovery, but
  // nothing in the UI triggers it deliberately any more — see the note in main.ts.

  // The share-link copy button must not claim success it did not have. A checkmark that fires
  // whether or not the write landed is how a broadcaster pastes the WRONG thing into the
  // channel they meant to send the link through, and only learns when nobody can watch.
  // Headless refuses the write, so what is measured here is the refusal being reported.
  const shareUrlAttr = await bc.evaluate(
    () => document.getElementById("copy-btn")?.getAttribute("data-share-url") ?? ""
  );
  await bc.click("#copy-btn");
  await new Promise((r) => setTimeout(r, 800));
  const copyState = await bc.evaluate(() => {
    const b = document.getElementById("copy-btn");
    const fb = document.querySelector(".share-fallback");
    return {
      claimedSuccess: !!b?.classList.contains("copied"),
      reportedFailure: !!b?.classList.contains("copy-failed"),
      title: b?.getAttribute("title") ?? "",
      fallbackShown: !!fb && !fb.classList.contains("hidden"),
      fallbackValue: fb?.value ?? "",
      selected: (window.getSelection()?.toString() ?? "").trim(),
    };
  });

  if (copyState.claimedSuccess) {
    // A real clipboard write; then the tick is honest and there is nothing to fall back to.
    check("a successful copy hides the fallback", copyState.fallbackShown, false);
    console.log("  note  clipboard write succeeded; measured the success path");
  } else {
    check("a refused copy does NOT show the success tick", copyState.claimedSuccess, false);
    check("a refused copy says so", copyState.reportedFailure, true);
    check("the failure is explained in the tooltip", /clipboard/i.test(copyState.title), true);
    check("the link is offered for manual copying", copyState.fallbackShown, true);
    // The whole link or nothing: a fallback missing #k= would copy cleanly and produce a
    // stream the recipient can never decrypt.
    check("the fallback carries the COMPLETE link", copyState.fallbackValue, shareUrlAttr);
    check("the fallback includes the key fragment", /#k=/.test(copyState.fallbackValue), true);
    console.log("  note  clipboard write refused (headless); measured the failure path");
  }
} catch (e) {
  failures++;
  console.error(`\nERROR: ${e.message}`);
} finally {
  await browser.close();
}

console.log(failures ? `\nFAIL: ${failures} assertion(s)\n` : "\nPASS: UI changes\n");
process.exit(failures ? 1 : 0);
