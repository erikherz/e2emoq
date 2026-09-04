/**
 * Measure text contrast on the rendered page, rather than trusting the palette.
 *
 * Written after a restyle made the Broadcast label dark-on-dark. The colour that broke it was
 * set by an ID selector two hundred lines away from the rule that changed the background, so
 * nothing about either rule looked wrong on its own — only the pair did, and only once painted.
 *
 * Computes WCAG 2.1 contrast from the COMPUTED styles, walking up for the first non-transparent
 * background, which is what a person actually sees. Gradients are the known blind spot: an
 * element painted with a background-image reports `rgba(0,0,0,0)` for background-color, so the
 * check falls back to the nearest solid ancestor and says when it did.
 *
 *   node scripts/e2e/contrast.mjs [origin]
 */
import puppeteer from "puppeteer";

const ORIGIN = process.argv[2] || "https://e2emoq.com";
// Everything a visitor reads on the landing page, plus the one control they must find.
const TARGETS = [
  "#nav-broadcast", ".hero-title", ".hero-features li", ".tagline",
  "h1", ".info-card h4", ".info-card p", ".promo-heading", ".card-link",
];
const AA_NORMAL = 4.5;
const AA_LARGE = 3.0;

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
await page.goto(ORIGIN, { waitUntil: "networkidle2", timeout: 60000 });

const results = await page.evaluate((sels) => {
  const lum = ([r, g, b]) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const parse = (s) => (s.match(/[\d.]+/g) || []).slice(0, 4).map(Number);

  const out = [];
  for (const sel of sels) {
    const el = document.querySelector(sel);
    if (!el) { out.push({ sel, missing: true }); continue; }
    const cs = getComputedStyle(el);

    // GRADIENT TEXT is unmeasurable this way and must be declared so, not scored.
    // `-webkit-text-fill-color: transparent` with background-clip: text paints the background
    // through the glyphs; `color` is then whatever was inherited and is never drawn. The
    // wordmark hit this and reported 2.12:1 as rgb(0,0,238) — the UA's default link blue,
    // which appears nowhere on screen. Scoring that would have been a false failure, and
    // silently skipping it would hide a real one, so it is reported as unmeasured.
    if (cs.webkitTextFillColor === "rgba(0, 0, 0, 0)" || cs.webkitTextFillColor === "transparent") {
      out.push({ sel, gradientText: true });
      continue;
    }

    const fg = parse(cs.color);

    // Walk up for the first opaque background. A gradient reports no background-color, so note
    // it: the measurement is then against the surface behind the gradient, not the gradient.
    let node = el, bg = null, gradient = false;
    while (node) {
      const s = getComputedStyle(node);
      if (s.backgroundImage && s.backgroundImage !== "none") gradient = true;
      const c = parse(s.backgroundColor);
      if (c.length >= 3 && (c[3] === undefined || c[3] > 0.9)) { bg = c; break; }
      node = node.parentElement;
    }
    if (!bg) { out.push({ sel, noBg: true }); continue; }

    const L1 = lum(fg), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const px = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight, 10) >= 700;
    out.push({
      sel, gradient,
      ratio: Math.round(ratio * 100) / 100,
      large: px >= 24 || (bold && px >= 18.66),
      fg: cs.color, bg: `rgb(${bg.slice(0, 3).join(",")})`,
    });
  }
  return out;
}, TARGETS);

let fails = 0;
for (const r of results) {
  if (r.missing) { console.log(`skip  ${r.sel} — not on this page`); continue; }
  if (r.noBg) { console.log(`skip  ${r.sel} — no opaque background found`); continue; }
  if (r.gradientText) {
    console.log(`n/a   ${r.sel.padEnd(20)} gradient-filled text — check this one by eye`);
    continue;
  }
  const need = r.large ? AA_LARGE : AA_NORMAL;
  const ok = r.ratio >= need;
  if (!ok) fails++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${r.sel.padEnd(20)} ${String(r.ratio).padStart(6)}:1  ` +
    `(needs ${need})${r.gradient ? "  [over a gradient — measured against the solid behind it]" : ""}`
  );
  if (!ok) console.log(`        ${r.fg} on ${r.bg}`);
}

await browser.close();
console.log(fails ? `\n${fails} below WCAG AA` : "\nall pass WCAG AA");
process.exit(fails ? 1 : 0);
