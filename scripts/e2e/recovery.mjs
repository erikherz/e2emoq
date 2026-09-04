// Round-trips the vault recovery phrase module.
//
// Unlike the other suites here this one hits NO network and needs no deployment: the module
// is pure, and what it guarantees — that a phrase rebuilds exactly the vault it came from —
// is the kind of thing that fails silently and takes someone's seeds with it. Run it before
// any change to src/seeds/recovery.ts.
//
//   node scripts/e2e/recovery.mjs
//
// The module is TypeScript, so it is bundled with the esbuild that vite already depends on.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "wf-recovery-"));
const bundle = join(dir, "recovery.mjs");
execFileSync("npx", ["esbuild", "src/seeds/recovery.ts", "--bundle", "--format=esm", `--outfile=${bundle}`], {
  stdio: ["ignore", "ignore", "inherit"],
});

const { newPhrase, checkPhrase, deriveVault, WORDS, PHRASE_LENGTH, suggest, describeProblem } =
  await import(pathToFileURL(bundle).href);

let fails = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
};

// The wordlist is frozen: 256 entries, one byte each. A 257th word or a reordering silently
// invalidates every phrase anybody has written down, so this is the first thing checked.
check("wordlist is exactly 256", WORDS.length === 256, `len=${WORDS.length}`);
check("wordlist is unique", new Set(WORDS).size === 256);
const clashes = new Set();
for (const w of WORDS) {
  const p = w.slice(0, 4);
  if (WORDS.filter((x) => x.slice(0, 4) === p).length > 1) clashes.add(p);
}
check("no two words share a 4-letter prefix", clashes.size === 0, [...clashes].join(","));

// A checksum that rejects its own output would lock people out of vaults they just made.
let allValid = true;
const seen = new Set();
for (let i = 0; i < 300; i++) {
  const p = await newPhrase();
  if (p.split(" ").length !== PHRASE_LENGTH) allValid = false;
  if (await checkPhrase(p)) allValid = false;
  seen.add(p);
}
check("300 generated phrases all validate", allValid);
check("300 generated phrases are all distinct", seen.size === 300, `distinct=${seen.size}`);

// Determinism IS the product promise: the same words rebuild the same vault, anywhere.
const phrase = await newPhrase();
const a = await deriveVault(phrase);
const b = await deriveVault(phrase);
check("derivation is deterministic", a.pubkey === b.pubkey && a.secret === b.secret);
check("id and secret differ", a.pubkey !== a.secret);
check("id matches the API's pubkey rule", /^[A-Za-z0-9_-]{16,128}$/.test(a.pubkey), a.pubkey);

// What people actually type is never tidy.
const messy = `  ${phrase.toUpperCase().replace(/ /g, "   ")}  `;
check("tolerates case and stray whitespace", (await deriveVault(messy)).pubkey === a.pubkey);
check("different phrases give different vaults",
  (await deriveVault(await newPhrase())).pubkey !== a.pubkey);

// A wrong word must be LOCATED, not merely detected — "check word 7" sends someone back to
// their piece of paper, "no vault found" sends them nowhere.
const words = phrase.split(" ");
const broken = [...words];
broken[6] = "zzzz";
let prob = await checkPhrase(broken.join(" "));
check("bad word is caught and located", prob?.kind === "word" && prob.position === 7,
  JSON.stringify(prob));

// Two real words swapped: invisible to a per-word check, which is why the checksum exists.
const swapped = [...words];
[swapped[1], swapped[2]] = [swapped[2], swapped[1]];
prob = await checkPhrase(swapped.join(" "));
check("swapped words caught", prob !== null, JSON.stringify(prob));

prob = await checkPhrase(words.slice(0, 5).join(" "));
check("short phrase reports length", prob?.kind === "length" && prob.got === 5, JSON.stringify(prob));
check("problems describe themselves", typeof describeProblem(prob) === "string");
check("autocomplete narrows", suggest("gar").length > 0 && suggest("gar").every((w) => w.startsWith("gar")),
  JSON.stringify(suggest("gar")));

// One wrong word should slip past only 1 time in 256, by construction.
let missed = 0;
const TRIALS = 400;
for (let i = 0; i < TRIALS; i++) {
  const p = (await newPhrase()).split(" ");
  const pos = Math.floor(Math.random() * (PHRASE_LENGTH - 1));
  const wrong = WORDS[Math.floor(Math.random() * 256)];
  if (wrong === p[pos]) continue;
  p[pos] = wrong;
  if (!(await checkPhrase(p.join(" ")))) missed++;
}
console.log(`       single-word typos slipping through: ${missed}/${TRIALS} (expect ~${(TRIALS / 256).toFixed(1)})`);
check("typo detection is near the 255/256 bound", missed < TRIALS * 0.03, `missed=${missed}`);

rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILURES` : "\nall recovery checks passed");
process.exit(fails ? 1 : 0);
