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
# The media path. Setting this is what puts you on moq.pro; deleting it falls back to
# the self-hosted fleet with no deploy.
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

Full reference, including rollback and the fleet path, in [`SECRETS.md`](SECRETS.md).

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
