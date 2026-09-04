// What the overlay sanitiser allows and refuses.
//
//   node scripts/e2e/overlay-policy.mjs
//
// Companion to overlay-xss.mjs, which drives a real broadcast and a real viewer and proves the
// end-to-end result. This one tests the policy itself: no publish key, no relay, no deploy, so
// it runs before a change ships rather than after. It bundles the REAL src/overlay-sanitize.ts
// with esbuild — not a copy of its config, which would drift the first time the policy changed
// and then quietly agree with itself.
//
// The page is served on a stubbed https://e2emoq.com origin, because half the iframe policy
// is a comparison against window.location.host. On a data: or file: URL that comparison is
// meaningless and every same-origin check would pass for the wrong reason.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(os.tmpdir(), `overlay-sanitize-${process.pid}.js`);
const ORIGIN = "https://e2emoq.com";

execFileSync(
  "npx",
  ["esbuild", "src/overlay-sanitize.ts", "--bundle", "--format=iife", "--global-name=OV", `--outfile=${OUT}`],
  { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] }
);
const bundle = fs.readFileSync(OUT, "utf8");
fs.unlinkSync(OUT);

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const browser = await puppeteer.launch({ headless: "new" });

try {
  const page = await browser.newPage();
  // Serve one stub document on the real origin and let nothing else out to the network.
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (req.url() === `${ORIGIN}/`) {
      req.respond({ status: 200, contentType: "text/html", body: "<!doctype html><title>t</title>" });
    } else {
      req.abort();
    }
  });
  await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
  await page.addScriptTag({ content: bundle });

  const run = (html) => page.evaluate((h) => {
    const r = window.OV.renderOverlay(h);
    // Re-parse so attributes can be read as the browser sees them, not as text.
    const box = document.createElement("div");
    box.innerHTML = r.html;
    const el = (sel) => box.querySelector(sel);
    return {
      html: r.html,
      removed: r.removed,
      tags: [...box.querySelectorAll("*")].map((n) => n.tagName.toLowerCase()),
      iframe: el("iframe") && {
        src: el("iframe").getAttribute("src"),
        sandbox: el("iframe").getAttribute("sandbox"),
        allow: el("iframe").getAttribute("allow"),
        referrerpolicy: el("iframe").getAttribute("referrerpolicy"),
        srcdoc: el("iframe").getAttribute("srcdoc"),
      },
      anchorRel: el("a")?.getAttribute("rel") ?? null,
    };
  }, html);

  console.log("\noverlay sanitiser policy\n");
  console.log("  what a broadcaster should be able to write");

  const heading = await run("<h2>Live from the newsroom</h2>");
  check("headings keep their tag", heading.tags.includes("h2"), heading.html);

  const list = await run("<ul><li>One</li><li>Two</li></ul>");
  check("lists keep their structure", list.tags.join(",") === "ul,li,li", list.html);

  const table = await run("<table><tbody><tr><th>a</th><td>b</td></tr></tbody></table>");
  check("tables survive", table.tags.includes("table") && table.tags.includes("th"), table.html);

  const rich = await run("<hr><blockquote>q</blockquote><h3>h</h3><pre><code>x</code></pre>");
  check("rules, quotes and code survive", ["hr", "blockquote", "h3", "pre", "code"].every((t) => rich.tags.includes(t)), rich.html);

  const styled = await run('<div style="color:red">red</div><b>b</b><em>e</em><img src="https://x.test/a.png">');
  check("the original allowlist still works", styled.tags.join(",") === "div,b,em,img", styled.html);

  // A custom ALLOWED_URI_REGEXP makes DOMPurify judge every unexempted attribute VALUE as a
  // URL, which deletes ordinary numbers and keywords. Cheap to get wrong, invisible when it is.
  const attrs = await run('<table><tr><td colspan="2" width="120">a</td></tr></table><video src="https://x.test/v.mp4" controls loop></video>');
  check("plain attributes survive the URL check", /colspan="2"/.test(attrs.html) && /width="120"/.test(attrs.html) && /controls/.test(attrs.html), attrs.html);

  console.log("\n  embeds: another site yes, this one never");

  const embed = await run('<iframe src="https://www.polleverywhere.com/embed/x" allow="camera; microphone" srcdoc="<b>x</b>"></iframe>');
  check("a cross-origin https embed is kept", !!embed.iframe, embed.html);
  check("its sandbox is forced", embed.iframe?.sandbox === "allow-scripts allow-same-origin allow-popups allow-forms allow-presentation", embed.iframe?.sandbox);
  check("it cannot navigate the viewer away", !/allow-top-navigation/.test(embed.iframe?.sandbox || ""));
  check("camera and microphone are not delegated to it", !/camera|microphone|geolocation|display-capture/.test(embed.iframe?.allow || ""), embed.iframe?.allow);
  check("the share link is not sent to it as a referrer", embed.iframe?.referrerpolicy === "no-referrer", embed.iframe?.referrerpolicy);
  check("srcdoc is stripped even on an allowed embed", !embed.iframe?.srcdoc);

  for (const [name, html] of [
    ["a same-host embed", `<iframe src="${ORIGIN}/watch"></iframe>`],
    ["a root-relative embed", `<iframe src="/"></iframe>`],
    ["a protocol-relative same-host embed", `<iframe src="//e2emoq.com/"></iframe>`],
    ["an http embed", `<iframe src="http://example.test/"></iframe>`],
    ["a javascript: embed", `<iframe src="javascript:window.__pwned=1"></iframe>`],
    ["a srcdoc-only embed", `<iframe srcdoc="<img src=x onerror=alert(1)>"></iframe>`],
  ]) {
    const r = await run(html);
    check(`${name} is refused`, !r.iframe, r.html);
    check(`${name} is reported to the author`, r.removed.length > 0, JSON.stringify(r.removed));
  }

  console.log("\n  the things that could reach the content key");

  const onerror = await run('<img src=x onerror="window.__pwned=1">');
  check("event handlers are stripped", !/on\w+\s*=/i.test(onerror.html), onerror.html);

  const jsHref = await run('<a href="javascript:window.__pwned=1">x</a>');
  check("javascript: URLs are stripped", !/javascript:/i.test(jsHref.html), jsHref.html);

  const script = await run("<script>window.__pwned=1<\/script><style>body{display:none}</style>");
  check("script and style are removed", !/script|style/i.test(script.html), script.html);

  const forms = await run("<form><input name=x><button>go</button><textarea></textarea></form>");
  check("form controls are removed", forms.tags.length === 0, forms.html);

  const clobber = await run('<div id="location">x</div><img name="body">');
  check("id and name are stripped (DOM clobbering)", !/\bid=|\bname=/i.test(clobber.html), clobber.html);

  const target = await run('<a href="https://x.test/" target="_blank">x</a>');
  check("target=_blank gets rel=noopener", /noopener/.test(target.anchorRel || ""), target.anchorRel);

  console.log("\n  the author is told what happened");
  const mixed = await run("<h2>fine</h2><script>bad<\/script>");
  check("a clean snippet reports nothing removed", (await run("<h2>fine</h2>")).removed.length === 0);
  check("a stripped snippet reports it", mixed.removed.length > 0, JSON.stringify(mixed.removed));
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} failed\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
