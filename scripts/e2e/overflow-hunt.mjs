// What, on the broadcast page, is wider than a phone?
//
//   node scripts/e2e/overflow-hunt.mjs [origin]
//
// Written for a specific report: on an iPhone in portrait the chat overlay ran off the right
// edge and the Send button could only be reached by swiping. The chat panel measures fine on
// its own (see chat-fits.mjs), which points at the other half of that failure — on iOS, ONE
// element wider than the viewport widens the layout viewport for the whole page, and anything
// sized `width: 100%` and `position: fixed` is then 100% of something wider than the screen.
//
// So this does not test the chat. It walks every element and reports the ones sticking out,
// nearest cause first, because the fix belongs wherever the overflow starts.
import puppeteer from "puppeteer";

const ORIGIN = (process.argv[2] || "https://e2emoq.com").replace(/\/+$/, "");
const WIDTH = Number(process.argv[3] || 390);

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
const page = await browser.newPage();
await page.setViewport({ width: WIDTH, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
await page.goto(`${ORIGIN}/broadcast`, { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 2500));

const report = async (label) => {
  const r = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    for (const el of document.querySelectorAll("*")) {
      const b = el.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) continue;
      if (getComputedStyle(el).display === "none") continue;
      // Only elements that actually stick out to the right, by more than a rounding pixel.
      if (b.right > vw + 1) {
        out.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || "",
          cls: (typeof el.className === "string" ? el.className : "").slice(0, 48),
          right: Math.round(b.right),
          width: Math.round(b.width),
          depth: (() => { let d = 0, p = el; while ((p = p.parentElement)) d++; return d; })(),
        });
      }
    }
    return {
      vw,
      scrollW: document.documentElement.scrollWidth,
      bodyScrollW: document.body.scrollWidth,
      offenders: out.sort((a, b) => a.depth - b.depth).slice(0, 12),
    };
  });

  console.log(`\n— ${label} —`);
  console.log(`  viewport ${r.vw}px, document scrollWidth ${r.scrollW}px, body ${r.bodyScrollW}px`);
  if (r.scrollW <= r.vw) {
    console.log("  nothing overflows");
  } else {
    console.log("  overflowing (outermost first):");
    for (const o of r.offenders) {
      console.log(`    ${"".padStart(o.depth, " ")}${o.tag}${o.id ? "#" + o.id : ""}${o.cls ? "." + o.cls.replace(/\s+/g, ".") : ""}  w=${o.width} right=${o.right}`);
    }
  }
  return r;
};

const before = await report("as loaded");

// Open chat the way the button does. Without a publish key the settings write is a no-op and
// the panel still opens, which is exactly the state a broadcaster hits before pasting a key.
await page.evaluate(() => {
  document.querySelector("#more-btn")?.click();
  document.querySelector("#chat-btn")?.click();
});
await new Promise((r) => setTimeout(r, 1500));
const after = await report("with chat open");

await browser.close();
const bad = after.scrollW > after.vw || before.scrollW > before.vw;
console.log(bad ? "\nsomething overflows — see above\n" : "\nno horizontal overflow at this width\n");
process.exit(bad ? 1 : 0);
