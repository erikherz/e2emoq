// Regenerates public/apple-touch-icon.png from public/favicon.svg.
//
//   node scripts/make-touch-icon.mjs
//
// Needs rsvg-convert (brew install librsvg). The PNG is COMMITTED, so this only has to run
// when the mark changes — nothing in the build depends on it.
//
// Why a PNG exists at all when there is a perfectly good SVG favicon: iOS does not use the
// favicon for a home-screen bookmark. It looks for an apple-touch-icon, then a manifest icon,
// and if it finds neither it draws a letter tile from the site name. Link unfurlers (Gmail,
// iMessage, Slack) reach for this PNG too, ahead of the SVG favicon — which is how a stale
// copy of it kept showing the OLD product's icon in shared links long after the rebrand. Safari has never accepted SVG for this, so a raster copy is the only answer.
//
// Two things the wrapper does that a straight `rsvg-convert favicon.svg` would not:
//
//   OPAQUE BACKGROUND. iOS composites a transparent touch icon onto BLACK, not onto the
//   wallpaper. That happens to suit this flower, but relying on it would mean the icon's
//   background is decided by an Apple default rather than by us; #06090d is --bg-primary, so
//   the tile matches the site whatever iOS decides to do next.
//
//   INSET. The favicon is drawn edge-to-edge, which is right for a 16px browser tab and wrong
//   for a home screen: iOS masks the tile to a squircle and every other icon on the screen
//   leaves a margin. 20/180 ≈ 11% keeps the shackle clear of the corner radius.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SIZE = 180; // what iOS asks for at @3x; it downsamples for every smaller slot
const INSET = 20;
const BG = "#06090d"; // --bg-primary

const root = new URL("..", import.meta.url).pathname;
const src = readFileSync(join(root, "public/favicon.svg"), "utf8");

// Keep the drawing, drop its <svg> element — its viewBox is 0 0 64 64 and the transform below
// depends on that, so fail loudly rather than silently mis-scaling if that ever changes.
if (!/viewBox="0 0 64 64"/.test(src)) throw new Error("favicon.svg is no longer a 64x64 viewBox");
const inner = src.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");

const scale = (SIZE - 2 * INSET) / 64;
const wrapper = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
<rect width="${SIZE}" height="${SIZE}" fill="${BG}"/>
<g transform="translate(${INSET},${INSET}) scale(${scale})">${inner}</g>
</svg>`;

const tmp = join(mkdtempSync(join(tmpdir(), "e2emoq-icon-")), "icon.svg");
writeFileSync(tmp, wrapper);

const out = join(root, "public/apple-touch-icon.png");
execFileSync("rsvg-convert", ["-w", String(SIZE), "-h", String(SIZE), tmp, "-o", out]);
console.log(`wrote ${out} (${SIZE}x${SIZE})`);
