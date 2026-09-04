// Checks the sealed half of the Link watermark.
//
// The QR drawn into the video is private for free — it is only ever pixels. The TAPPABLE copy
// is not: it travels as text through our Worker and D1 so that someone watching on a phone,
// who cannot scan their own screen, still gets somewhere to tap. That makes this the one part
// of the feature where the destination could leak, and the seal is what stops it.
//
// So what is asserted here is mostly negative: that the stored value does NOT contain the URL,
// and that every party who should not be able to open it cannot.
//
//   node scripts/e2e/link-watermark.mjs
//
// No network and no deployment — this is the crypto, not the wiring.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "wf-link-"));
const bundle = join(dir, "mc.mjs");
execFileSync("npx", ["esbuild", "src/crypto/media-crypto.ts", "--bundle", "--format=esm", `--outfile=${bundle}`], {
  stdio: ["ignore", "ignore", "inherit"],
});
const { deriveLinkKey, deriveChatKey, deriveMediaKey, generateLinkSecret, sealText, openText } =
  await import(pathToFileURL(bundle).href);

let fails = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
};

const URL_ = "https://example.com/support-me";
const streamId = "ab3d9";
const secret = generateLinkSecret();
const opts = { streamId, salt: "server-issued-salt", passcode: "K7QMWX42" };

// ---- The round trip a broadcaster and a viewer actually make ----
const bKey = await deriveLinkKey(secret, opts);
const sealed = await sealText(bKey, URL_);
const vKey = await deriveLinkKey(secret, opts);
check("a viewer with the same link opens it", (await openText(vKey, sealed)) === URL_);

// ---- What the stored value must not reveal ----
//
// This is the whole point of the column being sealed, so it is checked directly rather than
// inferred from the fact that encryption was called.
check("the stored blob does not contain the URL", !sealed.includes("example.com"));
check("the stored blob does not contain the path", !sealed.includes("support-me"));
check("the stored blob is nonce.ciphertext", /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(sealed), sealed.slice(0, 24) + "…");

// Two seals of the SAME url must differ, or the blob becomes a fingerprint: anyone holding the
// database could tell that two broadcasters were promoting the same destination without ever
// decrypting it.
const again = await sealText(bKey, URL_);
check("sealing twice gives different ciphertext", sealed !== again);
check("...and both still open", (await openText(vKey, again)) === URL_);

// ---- Everyone who should be shut out ----
const wrong = async (label, altSecret, altOpts) =>
  check(label, (await openText(await deriveLinkKey(altSecret, altOpts), sealed)) === null);

await wrong("a different link secret cannot open it", generateLinkSecret(), opts);
await wrong("the wrong passcode cannot open it", secret, { ...opts, passcode: "WRONGPAS" });
await wrong("no passcode cannot open it", secret, { streamId, salt: opts.salt });
await wrong("a rotated salt cannot open it", secret, { ...opts, salt: "rotated" });
await wrong("another stream's id cannot open it", secret, { ...opts, streamId: "zz999" });

// The salt only exists from go-live onwards. A link sealed before then is sealed against the
// fallback, which no viewer can reproduce — this asserts the failure that resealLink() in
// main.ts exists to prevent, so that the reason for that call is pinned by a test.
const preGoLive = await sealText(await deriveLinkKey(secret, { streamId, passcode: opts.passcode }), URL_);
check("a pre-go-live seal is unreadable once a salt is issued",
  (await openText(vKey, preGoLive)) === null);

// ---- Key separation ----
//
// The link, the chat and the video come from one secret through different HKDF contexts.
// Compromising the relay's view of one must not yield another.
const chatKey = await deriveChatKey(secret, opts);
check("the chat key cannot open a link", (await openText(chatKey, sealed)) === null);

// deriveMediaKey installs globally rather than returning, so it is exercised only for the
// property that matters here: it must not disturb the link key.
await deriveMediaKey(secret, opts);
check("deriving the media key leaves the link key working",
  (await openText(await deriveLinkKey(secret, opts), sealed)) === URL_);

// ---- Tampering ----
//
// AES-GCM is authenticated, so a modified blob must fail rather than decrypt to something
// else. A viewer is invited to TAP this, so a forged destination is the worst outcome.
const [nonce, ct] = sealed.split(".");
const flip = (s) => {
  const i = s.length - 2;
  const c = s[i] === "A" ? "B" : "A";
  return s.slice(0, i) + c + s.slice(i + 1);
};
check("a tampered ciphertext is rejected", (await openText(vKey, `${nonce}.${flip(ct)}`)) === null);
check("a tampered nonce is rejected", (await openText(vKey, `${flip(nonce)}.${ct}`)) === null);
check("a truncated blob is rejected", (await openText(vKey, nonce)) === null);
check("an empty blob is rejected", (await openText(vKey, "")) === null);
check("garbage is rejected", (await openText(vKey, "not.base64url!!")) === null);

// ---- Length ----
//
// The Worker bounds this column at 2048 characters. A URL long enough to be worth encoding
// must seal to comfortably less than that, or the write is rejected and the tappable copy
// silently never appears.
const longUrl = "https://example.com/" + "p".repeat(300);
const longSealed = await sealText(bKey, longUrl);
check("a 320-character URL seals well inside the 2048 cap", longSealed.length < 2048,
  `${longSealed.length} chars`);

rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILURES` : "\nall link-watermark checks passed");
process.exit(fails ? 1 : 0);
