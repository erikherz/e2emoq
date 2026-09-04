// Discovery pass: open /broadcast with fake media devices and dump the interactive DOM,
// so the harness can drive real controls instead of guessed selectors.
import puppeteer from "puppeteer";

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const page = await browser.newPage();
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto("https://e2emoq.com/broadcast", { waitUntil: "networkidle2", timeout: 60000 });
await new Promise((r) => setTimeout(r, 4000));

const dom = await page.evaluate(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    cls: el.className && typeof el.className === "string" ? el.className.slice(0, 60) : null,
    title: el.getAttribute("title"),
    aria: el.getAttribute("aria-label"),
    text: (el.textContent || "").trim().slice(0, 40) || null,
    visible: visible(el),
  });
  return {
    url: location.href,
    controls: [...document.querySelectorAll("button,[role=button],input")].map(describe),
    media: [...document.querySelectorAll("video,canvas")].map((el) => ({
      ...describe(el),
      w: el.videoWidth ?? el.width,
      h: el.videoHeight ?? el.height,
    })),
  };
});

console.log(JSON.stringify(dom, null, 2));
console.log("\n--- console ---");
console.log(logs.slice(0, 25).join("\n"));

await browser.close();
