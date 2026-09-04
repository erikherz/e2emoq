// Does the simplified broadcaster UI actually render in production?
import puppeteer from "puppeteer";

const ORIGIN = process.argv[2] || "https://e2emoq.com";
let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
  if (!ok) fails++;
};

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
await page.goto(`${ORIGIN}/broadcast`, { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 2500));

const ui = await page.evaluate(() => {
  const vis = (el) => !!el && getComputedStyle(el).display !== "none";
  const bar = document.querySelector(".publish-controls");
  const labelsIn = (root) =>
    root ? [...root.querySelectorAll(".btn-label")].filter((l) => vis(l.closest("button"))).map((l) => l.textContent) : [];
  const panel = document.querySelector("#publish-more-panel");
  const cb = document.querySelector("#passcode-enabled");
  return {
    bar: labelsIn(bar),
    panelHidden: panel ? panel.classList.contains("hidden") : null,
    inPanel: labelsIn(panel),
    hasProtect: !!document.querySelector("#protect-btn"),
    // Protect is icon-only, so its state lives in the accessible name and in the shape of the
    // padlock — not in visible text. This used to assert on textContent, which went on passing
    // right up until the label was removed and then failed for the right reason.
    protectName: document.querySelector("#protect-btn")?.getAttribute("aria-label") ?? null,
    protectPath: document.querySelector("#protect-icon-path")?.getAttribute("d") ?? null,
    protectPanelHidden: document.querySelector("#protect-panel")?.classList.contains("hidden") ?? null,
    passcodeChecked: cb ? cb.checked : null,
    passcodeBoxHidden: document.querySelector("#passcode-box")?.classList.contains("hidden") ?? null,
  };
});

console.log(`\n  bar:    ${ui.bar.join(" · ")}`);
console.log(`  in More: ${ui.inPanel.join(" · ")}\n`);

check("the resting bar is Camera + Audio + More", JSON.stringify(ui.bar) === JSON.stringify(["Camera", "Audio", "More"]), ui.bar.join(","));
check("the More panel starts closed", ui.panelHidden === true);
check("Screen/Location/Handle/Link/Chat are inside More", ["Screen", "Location", "Handle", "Link", "Chat"].every((n) => ui.inPanel.includes(n)), ui.inPanel.join(","));
check("Protect exists", ui.hasProtect);
check("Protect names itself as unset", /no passcode set/i.test(ui.protectName ?? ""), `got ${ui.protectName}`);
check("the padlock starts OPEN", ui.protectPath?.startsWith("M7 9V6") === true);
check("the Protect panel starts closed", ui.protectPanelHidden === true);
check("the passcode is OFF by default", ui.passcodeChecked === false, `checked=${ui.passcodeChecked}`);
check("no passcode is displayed while off", ui.passcodeBoxHidden === true);

// Opening More must reveal it, and arming the passcode must relabel Protect.
const opened = await page.evaluate(() => {
  document.querySelector("#more-btn")?.click();
  return !document.querySelector("#publish-more-panel")?.classList.contains("hidden");
});
check("clicking More opens the panel", opened === true);

const armed = await page.evaluate(async () => {
  document.querySelector("#protect-btn")?.click();
  const cb = document.querySelector("#passcode-enabled");
  cb.checked = true;
  cb.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 500));
  return {
    name: document.querySelector("#protect-btn")?.getAttribute("aria-label"),
    path: document.querySelector("#protect-icon-path")?.getAttribute("d"),
    armedClass: document.querySelector("#protect-btn")?.classList.contains("protect-armed"),
    boxHidden: document.querySelector("#passcode-box")?.classList.contains("hidden"),
    code: document.querySelector("#passcode-value")?.textContent?.trim().length ?? 0,
  };
});
check("arming renames Protect -> Protected", /^Protected/.test(armed.name ?? ""), `got ${armed.name}`);
// The state must be legible without colour vision — the shackle closes, it does not merely
// change hue. Checking the class alone would pass on a colour-only design.
check("the padlock CLOSES when armed", armed.path?.startsWith("M12 1a5") === true);
check("armed state is visually flagged", armed.armedClass === true);
check("the passcode becomes visible and non-empty", armed.boxHidden === false && armed.code > 0, `len=${armed.code}`);

// The header's Broadcast button, which is a link to the page you are already on. Both halves
// are asserted: gone here, and still present on the landing page — where it is the only call
// to action, so hiding it everywhere would be a much worse bug than leaving it everywhere.
const navHere = await page.evaluate(() => {
  const el = document.querySelector("#nav-broadcast");
  return el ? getComputedStyle(el).display !== "none" : null;
});
check("the Broadcast nav button is gone on /broadcast", navHere === false, `visible=${navHere}`);

const landing = await browser.newPage();
await landing.goto(ORIGIN, { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 800));
const navLanding = await landing.evaluate(() => {
  const el = document.querySelector("#nav-broadcast");
  return el ? getComputedStyle(el).display !== "none" : null;
});
check("it is still there on the landing page", navLanding === true, `visible=${navLanding}`);
await landing.close();

await browser.close();
console.log(fails ? `\n${fails} FAILURES\n` : "\nthe simplified UI is live and behaves\n");
process.exit(fails ? 1 : 0);
