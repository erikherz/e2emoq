// Render a local HTML file to PDF via headless Chrome.
//   node scripts/e2e/topdf.mjs <input.html> <output.pdf> [footer title]
import puppeteer from "puppeteer";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const [input, output, footerTitle] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: node scripts/e2e/topdf.mjs <input.html> <output.pdf> [footer title]");
  process.exit(1);
}

// The date was hardcoded here and silently outlived the document it stamped — a regenerated
// PDF carried the previous edition's date on every page while the title block said otherwise.
// Defaults to today so the footer cannot drift from the render again.
const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const footer = footerTitle || `e2eMoQ — Security Posture — ${today}`;

const browser = await puppeteer.launch({ headless: "new" });
const page = await browser.newPage();
await page.goto(pathToFileURL(resolve(input)).href, { waitUntil: "networkidle0" });
await page.pdf({
  path: resolve(output),
  format: "letter",
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: "<div></div>",
  footerTemplate:
    '<div style="width:100%;font-size:8pt;color:#7a838d;padding:0 16mm;font-family:-apple-system,sans-serif;">' +
    `<span style="float:left">${footer}</span>` +
    '<span style="float:right">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>' +
    "</div>",
  margin: { top: "18mm", bottom: "18mm", left: "16mm", right: "16mm" },
});
await browser.close();
console.log(`wrote ${resolve(output)}`);
