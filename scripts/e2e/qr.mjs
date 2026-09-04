// Checks the QR encoder that draws the Link watermark into the video.
//
// Like recovery.mjs this hits NO network and needs no deployment — the module is pure. It
// matters for the same reason: a QR that encodes the wrong bytes still LOOKS like a QR, so a
// regression here is invisible on screen and only shows up as a viewer's phone refusing to
// scan a broadcaster's link.
//
//   node scripts/e2e/qr.mjs
//
// HOW THE FIXTURES BELOW WERE ESTABLISHED
//
// They are not this implementation's own output blessed after the fact. Every matrix was
// compared module-by-module against segno (an independent encoder), and then rendered and read
// back with OpenCV's detector — a third implementation sharing no code with either. All the
// URL vectors decode to exactly the string that went in.
//
// Two discrepancies came out of that and are worth recording, because both look like bugs here
// and are not:
//
//  1. segno disagrees on the PAD bytes. Its write_padding_bits computes `8 - (length % 8)`
//     without the outer `% 8`, so it appends a whole spurious 0x00 codeword whenever the
//     stream already ends on a byte boundary — which, for byte mode with a full terminator, is
//     always. Harmless (it sits past the terminator, in the region a decoder ignores) but it
//     makes segno's matrix differ from ours on most inputs. With that one line patched, our
//     matrices match it exactly.
//  2. OpenCV cannot read either encoder's symbol for 62 identical bytes at level Q. Ours is
//     byte-identical to the corrected reference there, so that is the detector meeting a
//     pathologically regular symbol, not an encoding fault. It is also not an input this
//     feature can produce, since what gets encoded is always a URL.
//
// The module is TypeScript, so it is bundled with the esbuild vite already depends on.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "wf-qr-"));
const bundle = join(dir, "qr.mjs");
execFileSync("npx", ["esbuild", "src/media/qr.ts", "--bundle", "--format=esm", `--outfile=${bundle}`], {
  stdio: ["ignore", "ignore", "inherit"],
});
const { encodeQr } = await import(pathToFileURL(bundle).href);

let fails = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
};

const digest = (m) => {
  let s = "";
  for (let y = 0; y < m.size; y++) for (let x = 0; x < m.size; x++) s += m.get(x, y) ? "1" : "0";
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
};

// ---- Known answers ----
//
// Externally verified (see the header). A change to any of these means the bytes on screen
// changed, which is either a deliberate encoder change or a bug — never a detail.
const VECTORS = [
  ["https://a.co", "M", 1, "1fad3cbc6d75083f"],
  ["https://example.com", "L", 2, "3d5a3027e45b6ed3"],
  ["https://example.com", "M", 2, "09bdb9b82a64568e"],
  ["https://example.com", "Q", 2, "f58680ccc546ffba"],
  ["https://example.com", "H", 3, "99b91c20a496e315"],
  ["https://e2emoq.com/support", "M", 3, "ffcfb6b981e79622"],
  ["https://ko-fi.com/somebody", "M", 2, "e046d2f1a2324c5b"],
  ["https://example.com/a?b=1&c=2#frag", "M", 3, "0249c912589d7fe8"],
  ["https://example.com/café-üñîçøde", "M", 3, "47a5bdcd9c1daddd"],
  ["https://example.com/日本語", "M", 3, "48056132ef586ebd"],
  ["https://example.com/" + "x".repeat(80), "M", 6, "931d445df947d2c2"],
  ["a", "H", 1, "4f0490da33127a09"],
];
let vectorsOk = true;
for (const [text, ecl, version, want] of VECTORS) {
  const m = encodeQr(text, { ecl });
  const got = m && digest(m);
  if (!m || m.version !== version || got !== want) {
    vectorsOk = false;
    console.log(`       ${ecl} ${JSON.stringify(text.slice(0, 30))}: v${m?.version} ${got} != v${version} ${want}`);
  }
}
check(`${VECTORS.length} externally-verified vectors reproduce exactly`, vectorsOk);

// ---- Structure ----
//
// Cheap invariants that catch a matrix which is subtly malformed rather than merely different.
const m = encodeQr("https://e2emoq.com", { ecl: "M" });
check("size is 4 * version + 17", m.size === m.version * 4 + 17, `v${m.version} size=${m.size}`);

// Three finders, one per corner, and deliberately NOT a fourth — that asymmetry is how a
// scanner works out which way up the symbol is.
const finderAt = (ox, oy) => {
  for (let dy = 0; dy < 7; dy++) {
    for (let dx = 0; dx < 7; dx++) {
      const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      if (m.get(ox + dx, oy + dy) !== (ring !== 2)) return false;
    }
  }
  return true;
};
check("finder patterns in three corners", finderAt(0, 0) && finderAt(m.size - 7, 0) && finderAt(0, m.size - 7));
check("no finder in the fourth corner", !finderAt(m.size - 7, m.size - 7));

let timingOk = true;
for (let i = 8; i < m.size - 8; i++) {
  if (m.get(i, 6) !== (i % 2 === 0) || m.get(6, i) !== (i % 2 === 0)) timingOk = false;
}
check("timing patterns alternate", timingOk);
check("the always-dark module is dark", m.get(8, m.size - 8));

// ---- Version selection ----
//
// The watermark is drawn at a fixed footprint, so version is what decides whether a viewer's
// phone can resolve the modules. It must never come out larger than it needs to be.
let monotonic = true;
let prev = 0;
for (let len = 1; len <= 200; len += 1) {
  const v = encodeQr("h".repeat(len), { ecl: "M" })?.version ?? 99;
  if (v < prev) monotonic = false;
  prev = v;
}
check("version never shrinks as input grows", monotonic);
check("a short URL stays small", encodeQr("https://a.co/x", { ecl: "M" }).version <= 2);

// Higher error correction costs capacity, so it can only ever need the same version or more.
let eccOrdered = true;
for (const text of ["https://example.com", "https://example.com/" + "y".repeat(50)]) {
  const vs = ["L", "M", "Q", "H"].map((ecl) => encodeQr(text, { ecl }).version);
  if (vs[0] > vs[1] || vs[1] > vs[2] || vs[2] > vs[3]) eccOrdered = false;
}
check("stronger correction never needs a smaller version", eccOrdered);

// ---- Refusing, rather than silently truncating ----
//
// The caller turns null into a sentence for the broadcaster. Encoding a truncated URL would be
// far worse than declining: it would produce a scannable QR pointing somewhere wrong.
check("returns null past the version cap", encodeQr("z".repeat(500), { ecl: "M", maxVersion: 6 }) === null);
check("fits at a cap that is high enough", encodeQr("z".repeat(500), { ecl: "M", maxVersion: 20 }) !== null);

// The Link watermark's own budget: LINK_MAX_VERSION in main.ts is 4, and the promise made to
// the broadcaster in the "too long" message is "under about 60 characters". If these two ever
// disagree, the message sends people to shorten a URL that would have been refused anyway —
// or, worse, promises a length that does not fit.
const LINK_CAP = { ecl: "M", maxVersion: 4 };
check("the advertised ~60 characters really fit", encodeQr("h".repeat(60), LINK_CAP) !== null);
check("realistic tip-jar URLs fit", [
  "https://ko-fi.com/somebodyhere",
  "https://buymeacoffee.com/somebodyhere",
  "https://www.patreon.com/c/somebodyhere",
  "https://example.com/support",
].every((u) => encodeQr(u, LINK_CAP) !== null));
check("an over-long URL is declined, not shrunk", encodeQr("https://example.com/" + "q".repeat(60), LINK_CAP) === null);
check("handles the empty string", encodeQr("", { ecl: "M" })?.version === 1);

// Multi-byte characters must be counted as BYTES, not as characters — a length taken in
// characters would overflow the symbol and produce an unreadable one.
const wide = encodeQr("é".repeat(40), { ecl: "M" });
const narrow = encodeQr("e".repeat(40), { ecl: "M" });
check("multi-byte input is measured in bytes", wide.version > narrow.version,
  `${wide.version} vs ${narrow.version}`);

check("encoding is deterministic", digest(encodeQr("https://x.co", { ecl: "M" })) ===
  digest(encodeQr("https://x.co", { ecl: "M" })));

rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILURES` : "\nall qr checks passed");
process.exit(fails ? 1 : 0);
