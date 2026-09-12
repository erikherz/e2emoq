// Print the live shape of <moq-watch>, so a moved accessor is a fact rather than a guess.
//
//   node scripts/e2e/_catprobe.mjs
//
// WHY IT IS KEPT. The @moq upgrade moved the catalog from `el.broadcast.catalog.peek()` to
// `el.catalog` / `el.broadcast.out.catalog.peek()`. `el.broadcast` still existed, so the old
// optional-chained read returned undefined forever instead of throwing: recordings were written
// with no decoder config and replayed black, reporting "fed=235 dropped=0" the whole way. The
// same shape move silently disabled the audio watchdog and the iOS restore-audio button.
//
// The lesson that earns this file a place in the repo: a reader that cannot fail is not evidence
// about the thing it reads. When something downstream of <moq-watch> goes quiet, run this BEFORE
// theorising — it broadcasts, opens a viewer, and dumps the real property names.
//
// Underscore-prefixed because it asserts nothing and is not part of the suite.
import puppeteer from "puppeteer";
const b = await puppeteer.launch({ headless: "new", args: ["--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream","--autoplay-policy=no-user-gesture-required"] });
const bc = await b.newPage();
await bc.goto("https://e2emoq.com/broadcast", { waitUntil: "networkidle2", timeout: 60000 });
await bc.waitForSelector('button.publish-btn[title="Camera"]', { timeout: 30000 });
await bc.click('button.publish-btn[title="Camera"]');
await bc.waitForFunction(() => /[?&]stream=[a-z0-9]{5}/.test(location.href), { timeout: 30000 });
const share = await bc.evaluate(() => document.getElementById("copy-btn")?.getAttribute("data-share-url") ?? "");
await new Promise(r => setTimeout(r, 8000));
const v = await b.newPage();
await v.goto(share, { waitUntil: "networkidle2", timeout: 60000 });
await new Promise(r => setTimeout(r, 12000));
console.log(JSON.stringify(await v.evaluate(() => {
  const el = document.querySelector("moq-watch");
  if (!el) return { err: "no moq-watch" };
  const probe = (o) => o ? Object.keys(o).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(o)||{})) : null;
  const out = { elKeys: probe(el).slice(0, 45) };
  out.hasBroadcast = !!el.broadcast;
  out.broadcastKeys = probe(el.broadcast)?.slice(0,30) ?? null;
  const kinds = (o) => o === null || o === undefined ? String(o) : (typeof o === "object" ? probe(o).slice(0,12).join(",") : typeof o);
  out.elCatalog = kinds(el.catalog);
  out.elCatalogPeek = typeof el.catalog?.peek === "function";
  try { out.elCatalogVal = JSON.stringify(el.catalog?.peek?.() ?? el.catalog ?? null).slice(0,600); } catch(e){ out.e1 = String(e); }
  out.broadcastOut = kinds(el.broadcast?.out);
  try { out.outCatalog = JSON.stringify(el.broadcast?.out?.catalog?.peek?.() ?? null).slice(0,600); } catch(e){ out.e2 = String(e); }
  return out;
}), null, 1));
await b.close();
