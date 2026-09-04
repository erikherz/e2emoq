// Prove a broadcaster cannot execute script in a viewer's browser.
//
// The overlay is broadcaster-supplied markup written into the viewer's document — the same
// document holding the content key derived from the share link. If it can run script, it can
// read that key out of memory and the encryption story collapses.
//
// Note `<script>` is NOT the interesting payload: innerHTML never executes script tags. The
// real vector is event-handler attributes, which innerHTML honours. This fires several.

import puppeteer from "puppeteer";

const ORIGIN = process.argv[2] || "https://e2emoq.com";
const PK = process.env.WF_PUBLISH_KEY || "";
const BROADCAST_URL = `${ORIGIN}/broadcast${PK ? `?pk=${encodeURIComponent(PK)}` : ""}`;

// Each sets window.__pwned if it runs. The <script> tag is included to confirm the test
// would notice execution at all, not because innerHTML would run it.
//
// The last three exist because the overlay now allows embeds from other sites. That is only
// survivable while an embed cannot be OUR origin — a same-origin frame reaches window.parent
// and reads the content key — so the shapes that would be same-origin are attacked directly.
// scripts/e2e/overlay-policy.mjs tests the same rules at the unit level; this one proves the
// result in a real viewer holding a real key.
const PAYLOAD = [
  `<img src=x onerror="window.__pwned=1">`,
  `<svg onload="window.__pwned=1"></svg>`,
  `<a href="javascript:window.__pwned=1">click</a>`,
  `<div onmouseover="window.__pwned=1">hover</div>`,
  `<script>window.__pwned=1<\/script>`,
  `<iframe src="javascript:window.__pwned=1"></iframe>`,
  `<iframe src="/" id="same-origin-frame"></iframe>`,
  `<iframe srcdoc="<img src=x onerror=parent.__pwned=1>"></iframe>`,
  `<iframe src="https://example.com/" allow="camera; microphone; geolocation"></iframe>`,
].join("");

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

try {
  const bc = await browser.newPage();
  await bc.goto(BROADCAST_URL, { waitUntil: "networkidle2", timeout: 60000 });
  await bc.waitForSelector('button.publish-btn[title="Camera"]', { timeout: 30000 });
  await bc.click('button.publish-btn[title="Camera"]');
  await bc.waitForFunction(() => /[?&]stream=[a-z0-9]{5}/.test(location.href), { timeout: 30000 });
  const streamId = await bc.evaluate(() => new URLSearchParams(location.search).get("stream"));
  const shareUrl = await bc.evaluate(
    () => document.getElementById("copy-btn")?.getAttribute("data-share-url") || ""
  );
  // Mandatory now. Without it the viewer below sits on the passcode prompt, never renders an
  // overlay at all, and every check passes for the wrong reason — this test fails OPEN.
  await bc.waitForFunction(
    () => (document.getElementById("passcode-value")?.textContent || "").length === 8,
    { timeout: 30000 }
  );
  const passcode = await bc.evaluate(
    () => document.getElementById("passcode-value")?.textContent || ""
  );
  console.log(`  broadcasting ${streamId}`);
  await new Promise((r) => setTimeout(r, 7000));

  // Store the hostile overlay the way a broadcaster would.
  const put = await bc.evaluate(async (id, html) => {
    const r = await fetch("/api/streams", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream_id: id, overlay_html: html }),
    });
    return r.status;
  }, streamId, PAYLOAD);
  check("hostile overlay stored", put === 200, `HTTP ${put}`);

  // Watch it, as a viewer holding a real key.
  const ctx = await browser.createBrowserContext();
  const vw = await ctx.newPage();
  await vw.goto(shareUrl, { waitUntil: "networkidle2", timeout: 60000 });
  await vw.waitForSelector("#passcode-entry", { timeout: 30000 });
  await vw.type("#passcode-entry", passcode);
  await vw.click("#passcode-go");
  await new Promise((r) => setTimeout(r, 12000));

  // Nudge anything that needs interaction (onmouseover) before judging.
  await vw.evaluate(() => {
    document.querySelectorAll("*").forEach((el) => {
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
  });
  await new Promise((r) => setTimeout(r, 1500));

  const result = await vw.evaluate(() => {
    const box = document.querySelector(".viewer-html-overlay");
    return {
      pwned: !!window.__pwned,
      // The overlay actually rendered — otherwise everything below is vacuous.
      rendered: !!box && box.innerHTML.trim().length > 0,
      html: box?.innerHTML ?? "",
      frames: [...(box?.querySelectorAll("iframe") ?? [])].map((f) => ({
        src: f.getAttribute("src"),
        sandbox: f.getAttribute("sandbox"),
        allow: f.getAttribute("allow"),
      })),
      sameOrigin: [...(box?.querySelectorAll("iframe") ?? [])].filter((f) => {
        try { return new URL(f.src, location.href).host === location.host; } catch { return false; }
      }).length,
    };
  });

  check("the overlay rendered at all", result.rendered, result.rendered ? "" : "nothing in .viewer-html-overlay — the rest of this run proves nothing");
  check("no script executed in the viewer", result.pwned === false, result.pwned ? "window.__pwned was set" : "");
  check("no event handlers survived sanitisation", !/on\w+\s*=/i.test(result.html));
  check("no javascript: URLs survived", !/javascript:/i.test(result.html));
  check("no same-origin frame survived", result.sameOrigin === 0, `${result.frames.length} frame(s)`);
  check("no surviving frame was handed camera or mic", !result.frames.some((f) => /camera|microphone|geolocation/i.test(f.allow || "")));
  check("every surviving frame is sandboxed", result.frames.every((f) => (f.sandbox || "").includes("allow-scripts") && !/allow-top-navigation/.test(f.sandbox || "")));

  console.log(
    failures === 0
      ? "\nPASS: broadcaster markup is rendered inert — it cannot reach the content key."
      : `\nFAIL: ${failures} check(s) failed.`
  );
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error(`\nFAIL: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
