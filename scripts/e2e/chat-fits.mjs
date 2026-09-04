// The chat overlay has to fit a phone in portrait.
//
//   node scripts/e2e/chat-fits.mjs
//
// Reported from a real iPhone: the chat was wider than the screen and the send button sat off
// the right edge, reachable only by swiping the page sideways. A control you have to scroll
// the whole document to reach is not on the screen.
//
// Chat is built entirely in JS at connect time, so this rebuilds the panel the way
// chat-client.ts emits it, drops it under the REAL stylesheet from dist/index.html, and
// measures. No key, no relay, no deploy.

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
if (!styles.includes(".chat-panel")) {
  console.error("could not find the chat CSS in the built page");
  process.exit(1);
}

// The structure chat-client.ts builds: head (title + name button), message list, then the
// form with a text field and a send button. A long unbroken display name and a long word in a
// message are both included on purpose — those are what actually push a flex row wide.
const PANEL = `
<div class="video-chat-layout">
  <section><div style="height:120px"></div></section>
  <div id="broadcast-chat" class="chat-panel">
    <div class="chat-head">
      <span class="chat-title">Chat</span>
      <button class="chat-name-btn">ReallyLongDisplayNameThatSomeoneWillTypeEventually</button>
    </div>
    <div class="chat-msgs">
      <div class="chat-msg"><span class="chat-msg-name">Guest</span><span class="chat-msg-text">hello there</span></div>
      <div class="chat-msg"><span class="chat-msg-name">Guest</span><span class="chat-msg-text">Supercalifragilisticexpialidocious-and-then-some-more-characters</span></div>
    </div>
    <form class="chat-form">
      <input class="chat-text" placeholder="Say something…">
      <button class="chat-send" type="submit">Send</button>
    </form>
  </div>
</div>`;

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
  console.log("\nchat overlay, portrait\n");

  for (const [name, width] of DEVICES) {
    await page.setViewport({ width, height: 800, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    await page.setContent(
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<style>${styles}</style><div class="container">${PANEL}</div>`,
      { waitUntil: "load" }
    );

    const m = await page.evaluate(() => {
      const panel = document.querySelector(".chat-panel");
      const send = document.querySelector(".chat-send");
      const p = panel.getBoundingClientRect();
      const s = send.getBoundingClientRect();
      return {
        panel: Math.round(p.width),
        panelRight: Math.round(p.right),
        sendRight: Math.round(s.right),
        vw: document.documentElement.clientWidth,
        scrollW: document.documentElement.scrollWidth,
        // The real cause of the reported bug, and the one thing here headless Chrome cannot
        // demonstrate: iOS zooms the page when a focused input is under 16px, which narrows
        // the visual viewport under a fixed panel sized to the layout viewport and pushes
        // Send off the right edge. The geometry above passes on a device that then zooms, so
        // the invariant has to be asserted directly.
        inputPx: parseFloat(getComputedStyle(document.querySelector(".chat-text")).fontSize),
      };
    });

    // THE ASSERTION: the send button's right edge has to be on the screen, and the document
    // must not scroll sideways to get it there.
    const sendVisible = m.sendRight <= m.vw;
    const noScroll = m.scrollW <= m.vw;
    const noZoom = m.inputPx >= 16;
    check(
      sendVisible && noScroll && m.panel <= m.vw && noZoom,
      `${name} (${width}px): panel ${m.panel}px in ${m.vw}px, Send ends at ${m.sendRight}px, ` +
        `input ${m.inputPx}px` +
        (m.panel > m.vw ? "  — THE PANEL IS WIDER THAN THE SCREEN" : "") +
        (!sendVisible ? "  — SEND IS OFF-SCREEN" : "") +
        (!noScroll ? `  — THE PAGE SCROLLS SIDEWAYS (${m.scrollW}px)` : "") +
        (!noZoom ? "  — UNDER 16px, iOS WILL ZOOM ON FOCUS" : "")
    );
  }
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} failed\n` : "\nthe chat overlay fits, Send included\n");
process.exit(failures ? 1 : 0);
