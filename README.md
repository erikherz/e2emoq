# e2eMoQ

**Media over QUIC with end-to-end encryption.**

Live video in a browser, sub-second glass-to-glass, encrypted before it leaves the device.
No app, no account, no recording. Running at [e2emoq.com](https://e2emoq.com).

---

## What it does

A broadcaster opens `/broadcast`, switches on a camera, and gets a share link. Anyone holding
that link watches. That is the whole product.

What makes it worth building twice:

**The key is in the link, and the link never reaches the server.** At go-live the browser mints
a secret and puts it in the URL *fragment* — the `#k=…` part. Browsers never transmit a
fragment, so it cannot reach this Worker, its database, its logs, or the CDN. Every frame is
sealed with AES-256-GCM under a key derived from it before it is handed to the transport.

That is a structural property rather than a promise. There is no code path by which the
operator could decrypt a broadcast, because the material required never arrives on that side. A
subpoena, a rogue employee or a database breach yields ciphertext.

**Frames are independent.** Each one carries its own random nonce with the timestamp bound as
additional authenticated data. A lost frame costs exactly that frame — no chained state to
resynchronise, and a tampering relay fails the GCM tag rather than corrupting the picture.

**Chat is sealed the same way**, under a key derived from the same link through a different HKDF
context. The chat server relays text it cannot read, which also means there is nothing for
anyone to moderate.

### Recording, without giving anyone a key

A viewer can press **Record** while watching and get a file back; **Open a recording** plays it
again in the page. It opens only with the same share link that opened the broadcast, plus the
passcode if one was set.

The interesting part is what does *not* happen. **The bytes written to disk are the exact
ciphertext that came off the wire** — nothing is decrypted, re-encoded, or re-encrypted on the
way out. Recording is `append these bytes`. So:

- The recording inherits the stream's property for free. It is opaque without the link.
- The file never touches this Worker. It is saved to the viewer's own device.
- There is no way for the feature to get the encryption wrong, because it performs none.

This matters beyond convenience. "We need recording, so the key has to reach the server" is a
tempting and false step — it converts *we cannot decrypt* from a structural fact into a policy,
and a policy can be compelled. Capturing frames that are already sealed avoids the trade
entirely.

Two limits, since they are the reason to reach for something else:

- **~512 MB in memory** — roughly three to four hours at the default bitrate. Past that it
  stops and says so. Streaming to IndexedDB would lift it.
- **Playback is paced by the original timestamps**, so a recording replays at the rate it was
  broadcast, network stalls included. That is a faithful record, not a flattering one.

Implementation is `src/recording.ts` plus a tap on the existing decrypt seam. The file format is
documented at the top of that file: magic, a **sealed** header (the decoder config, so a
recording does not disclose even its own resolution), then length-prefixed frames.

### Video messages from viewers

A broadcaster can switch on **Accept video messages**. A viewer then records up to ten seconds
of themselves, previews it, and sends. The broadcaster sees it in an inbox, and can put it on
screen as a picture-in-picture inset.

Two design notes, because both were tempting to get wrong:

**Showing a message needed no delivery mechanism.** The broadcaster composites it into the
canvas — and the canvas is what gets encoded, encrypted and published. So a shown message
reaches every viewer inside the frames they are already receiving. No fan-out, no second
channel, no new key. The same trick the QR watermark uses.

**Nothing here holds a key.** The clip is sealed in the sender's browser under
`deriveMessageKey` (its own HKDF context, derived from the same link), uploaded as opaque
bytes, and stored as a D1 blob. Authorisation is the route tag, also derived from the link — so
everyone who can watch can send, nobody else can do either, and it is a bearer proof rather
than an identity. **We do not learn which viewer sent a message, and must not.**

Off by default, and that is a safety decision rather than a UX one: accepting video from anyone
holding a link makes the broadcaster's inbox a surface strangers can put things on, and this
product has no report path. Messages are capped at 10s / 1 MB, deleted when the broadcast ends,
and swept hourly.

### What it cannot do

Stated here rather than discovered later:

- **No moderation of content.** The operator cannot see a broadcast, so the only lever is
  stopping one. Terminating rotates the stream's HKDF salt, which re-keys it for everyone.
- **No in-product abuse reporting.** On an encrypted service the viewer is the only party who
  can observe a problem, so removing the report path removed the only sensor. Out-of-band only.
- **The link is the access control.** Anyone it is forwarded to can watch, and that cannot be
  revoked without re-keying the stream. An optional passcode adds a second secret, mixed into
  derivation, that the server also never sees.

Full claims, and their limits, at [`/trust`](https://e2emoq.com/trust).

---

## Architecture

```
browser (publisher)                  Cloudflare Worker            moq.pro CDN
  capture → WebCodecs                  admission                    relay
  → encrypt per frame  ──────────────► mint relay token ──────────► fan-out
  → MoQ over WebTransport                                             │
                                                                      ▼
browser (viewer)  ◄─────────────────── mint viewer token ◄──────── ciphertext
  decrypt ← key from #k= fragment
```

The Worker is a control plane, never a media path. It decides who may publish, mints
short-lived CDN tokens, records that a broadcast happened, and holds the kill switch. Media
goes browser → relay → browser and is opaque to every hop.

- **Client** — Vite + TypeScript, `@moq/hang` components, `src/main.ts`
- **Worker** — `src/worker/index.ts`, D1 for state, a Durable Object per chat room
- **Encryption** — `src/crypto/media-crypto.ts`, patched into `@moq` at build time by
  `mediaCryptoPatch()` in `vite.config.ts`, which **fails the build** if it cannot find its
  seams rather than shipping an unencrypted media path

---

## Setting up your own

You need a Cloudflare account and a [moq.pro](https://moq.pro) account. Roughly fifteen
minutes.

### 1. Cloudflare Worker

```sh
git clone git@github.com:erikherz/e2emoq.git my-app
cd my-app
npm install
npx wrangler login
```

Create the database and note the id it prints:

```sh
npx wrangler d1 create my-app-db
```

Put your worker name and that database id in **`wrangler.jsonc`** (see the checklist below),
then create the schema:

```sh
npx wrangler d1 execute my-app-db --remote --file=src/worker/db/schema.sql
for m in src/worker/db/migrations/*.sql; do
  npx wrangler d1 execute my-app-db --remote --file="$m"
done
```

Duplicate-column errors are expected — `schema.sql` already contains most of what the early
migrations add. What matters is the final shape:

```sh
npx wrangler d1 execute my-app-db --remote --command="SELECT name FROM sqlite_master WHERE type='table'"
```

You want `users`, `streams`, `broadcast_events`, `watch_events`, `stream_salts`,
`broadcaster_access`, `revoked_batches`, `revoked_codes` — and **no** `geo_*` columns on
`broadcast_events` or `watch_events`.

Then build and deploy:

```sh
npm run deploy
```

Add a custom domain in the Cloudflare dashboard under **Workers & Pages → your worker →
Settings → Domains & Routes**. A `workers.dev` subdomain works for testing.

### 2. moq.pro

Sign in at [moq.pro](https://moq.pro) and note your **account root** — the path namespace your
broadcasts live under. Then generate a signing key **locally** and register only its public
half:

```sh
node scripts/moq-keygen.mjs --secret MOQ_PRO_JWK --out-file moqpro.jwk
```

It prints a public JWK and writes the private half to `moqpro.jwk` (chmod 600).

**Register the public JWK at moq.pro → Keys → + Add Key → Import Asymmetric.** Confirm it
appears with the `kid` the script printed.

> **Order matters, and getting it wrong is the single most likely way to lose an afternoon.**
> The instant `MOQ_PRO_JWK` exists as a secret, *every* broadcast routes to `cdn.moq.pro`. If
> the public half is not registered there yet, they all fail — the connection completes, ALPN
> negotiates, and the session dies a few hundred milliseconds later with nothing but
> "Connection lost". Register first.

Use **Import Asymmetric**, not the other two:

| Type | Who holds the private half | |
|---|---|---|
| Symmetric | you *and* moq.pro | a shared secret — the CDN can mint tokens as you |
| Asymmetric | moq.pro generates it | the private half existed on their side |
| **Import Asymmetric** | **only you** | they verify, they cannot mint ✓ |

Ed25519 only — `mintMoqProTokenEd25519()` hardcodes the curve, so an ES256 key will not work.

Only once it is listed:

```sh
cat moqpro.jwk | npx wrangler secret put MOQ_PRO_JWK
rm moqpro.jwk
```

The keygen also writes the public half beside it, as `moqpro.jwk.pub.json`. **Keep that.** It
is public material, and once the private half is a write-only Cloudflare secret it is the only
thing that later answers "which key is deployed?" — this repository's own copy is
[`moqpro.pub.json`](moqpro.pub.json), and its absence is what turned a one-line
misconfiguration into an afternoon.

### 3. Secrets

```sh
# The media path. REQUIRED — without it there is no CDN to publish to and going
# live fails.
cat moqpro.jwk | npx wrangler secret put MOQ_PRO_JWK

# YOUR moq.pro account root. REQUIRED — see the checklist, the default is not yours.
printf '%s' 'your-root' | npx wrangler secret put MOQ_PRO_ROOT

# Machine-only. Nobody types these; generate and forget.
printf '%s' "$(openssl rand -base64 32)" | npx wrangler secret put ISSUE_KEY
printf '%s' "$(openssl rand -base64 32)" | npx wrangler secret put CHALLENGE_SECRET

# You will type these. Put them in a password manager.
npx wrangler secret put PUBLISH_SECRET
npx wrangler secret put ADMIN_PASSWORD
```

`printf '%s'` rather than a bare pipe because `openssl` emits a trailing newline that would
otherwise land inside the secret.

Full reference, including rotation and rollback, in [`SECRETS.md`](SECRETS.md).

---

## What to change for your own deployment

### Files

| File | What | Why |
|---|---|---|
| **`wrangler.jsonc`** | `name` | must match your Worker exactly, or `wrangler deploy` creates a *second* one and leaves your domain pointed at the old |
| | `d1_databases[0].database_name` + `database_id` | from `wrangler d1 create` |
| **`moqpro.pub.json`** | replace, or delete | the public half of *your* signing key |
| **`index.html`** | `<title>`, the `<h1>` wordmark, `#site-tagline`, `.hero-title` | branding |
| **`public/favicon.svg`** | your mark | then `node scripts/make-touch-icon.mjs` to regenerate the PNG — **link unfurlers prefer the PNG**, so a stale one shows the wrong icon in every shared link |
| **`package.json`** | `name` (currently `moqplay`) | cosmetic |
| **`src/recording.ts`** | `MAX_BYTES`, and `MAGIC` if you fork the format | the buffer cap is memory-bound; changing `MAGIC` makes existing recordings unreadable |
| **`src/worker/db/schema.sql`** | the `broadcaster_access` seed | a placeholder; only matters if you re-enable OAuth |

Cosmetic only: `anonymous@e2emoq.com` appears in `schema.sql`, `src/worker/index.ts` and
`src/auth.ts` as the stand-in user while OAuth is off.

### The one that will silently break you

**`MOQ_PRO_ROOT` has a hardcoded fallback of `"erik"`** — this repository's author's account
root (`src/worker/index.ts`, `moqProAssign()`). Leave it unset and your Worker mints tokens
claiming a namespace that is not yours, signed by a key that has no authority over it. Every
broadcast fails, and the failure looks like a transport problem rather than a config one.

**Set `MOQ_PRO_ROOT`.**

### Not secrets, and fine to commit

`database_id` in `wrangler.jsonc` is an identifier, useless without account credentials.
`moqpro.pub.json` is public key material by definition.

---

## Verifying it works

```sh
# End-to-end: publish, watch, and confirm real decoded frames. This is the deploy gate.
node scripts/e2e/broadcast-watch.mjs https://your-domain

# Both consoles side by side, for when the gate fails and you need to know which half broke.
node scripts/e2e/pipeline-probe.mjs https://your-domain

# The broadcaster's console, unfiltered — a publisher that never connects logs no error at
# all, so a filtered view makes a publish failure look like a viewer failure.
node scripts/e2e/publish-probe.mjs https://your-domain

# Auto-minting a publish code must be silent on success and loud on failure.
node scripts/e2e/publish-code-fallback.mjs https://your-domain

# Text contrast, measured on the rendered page rather than trusted from the palette.
node scripts/e2e/contrast.mjs https://your-domain

# Video messages: hidden until opt-in, a viewer can send, the broadcaster can composite it,
# and a wrong route tag is refused for both submit and read.
node scripts/e2e/messages.mjs https://your-domain

# Recording: a file is produced, it carries no plaintext config, the right link opens it —
# and, the assertion that matters, a DIFFERENT link does not.
node scripts/e2e/recording.mjs https://your-domain

# What shape is the watch element's catalog? Run this when replay stops configuring a decoder;
# the accessor path is vendored-library internals and has moved before.
node scripts/e2e/catalog-shape.mjs
```

A useful check on a key you already have:

```sh
node scripts/moq-pubkey.mjs <jwk file> --expect <kid>
```

It recomputes the RFC 7638 thumbprint from `x` rather than trusting the file's own `kid`,
prints only the public half, and tells you whether it matches what is deployed.

---

## Development

```sh
npm run dev      # vite, localhost:3000 — no Worker, so no go-live
npm run build
npm run deploy   # build + wrangler deploy
```

`npx tsc --noEmit` reports ~500 errors and always has: `tsconfig.json` carries no DOM lib, so
every `window`, `document` and `location` is unresolved. It is **not** a signal. To typecheck
the Worker, which is real:

```sh
npx tsc --noEmit -p tsconfig.json 2>&1 | grep '^src/worker'
```

---

## Licence

Dual-licensed under either of

- **Apache License, Version 2.0** ([LICENSE-APACHE](LICENSE-APACHE))
- **MIT license** ([LICENSE-MIT](LICENSE-MIT))

at your option.

This matches the licence on the `@moq` packages this is built from, which avoids any
compatibility question between the application and its dependencies. The dual form is the Rust
ecosystem's convention and it exists for a reason worth knowing: **MIT contains no patent
language at all**, while Apache-2.0 carries an express patent grant and a retaliation clause.
In media coding, where patents are dense, that is not a formality — so contributors and users
get whichever instrument suits them.

Unless you state otherwise, any contribution you intentionally submit for inclusion shall be
dual-licensed as above, without additional terms.
