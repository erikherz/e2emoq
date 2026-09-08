// What shape is the watch element's catalog, actually? The recording header needs a real
// WebCodecs config and my guess at the accessor path produced nothing.
import puppeteer from "puppeteer";

const ORIGIN = "https://e2emoq.com";
const PK = process.env.WF_PUBLISH_KEY || "";
const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

try {
  const bc = await browser.newPage();
  await bc.goto(`${ORIGIN}/broadcast${PK ? `?pk=${encodeURIComponent(PK)}` : ""}`, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });
  await bc.waitForSelector('button.publish-btn[title="Camera"]', { timeout: 30000 });
  await bc.click('button.publish-btn[title="Camera"]');
  await bc.waitForFunction(
    () => document.querySelector("[data-share-url]")?.getAttribute("data-share-url")?.includes("#k="),
    { timeout: 40000 }
  );
  const shareUrl = await bc.$eval("[data-share-url]", (e) => e.getAttribute("data-share-url"));

  const vw = await browser.newPage();
  await vw.goto(shareUrl, { waitUntil: "networkidle2", timeout: 60000 });
  await vw.waitForFunction(
    () => [...document.querySelectorAll("canvas")].some((c) => c.width >= 320),
    { timeout: 45000 }
  );

  const dump = await vw.evaluate(() => {
    const el = document.querySelector("moq-watch");
    const walk = (o, d = 0) => {
      if (d > 2 || o == null || typeof o !== "object") return typeof o;
      return Object.fromEntries(
        Object.keys(o).slice(0, 24).map((k) => {
          let v;
          try { v = o[k]; } catch { return [k, "<throws>"]; }
          if (v && typeof v.peek === "function") {
            let p;
            try { p = v.peek(); } catch { p = "<peek throws>"; }
            return [k, { PEEKED: walk(p, d + 1) }];
          }
          return [k, walk(v, d + 1)];
        })
      );
    };
    const b = el?.backend;
    return {
      backendKeys: b ? Object.keys(b) : null,
      video: walk(b?.video, 0),
      videoCatalogPeek: (() => {
        try { return b?.video?.catalog?.peek?.(); } catch (e) { return `<${e.message}>`; }
      })(),
      audioCatalogPeek: (() => {
        try { return b?.audio?.catalog?.peek?.(); } catch (e) { return `<${e.message}>`; }
      })(),
      broadcastCatalog: (() => {
        try { return el?.broadcast?.catalog?.peek?.(); } catch (e) { return `<${e.message}>`; }
      })(),
    };
  });
  console.log(JSON.stringify(dump, null, 2).slice(0, 4000));
} finally {
  await browser.close();
}
