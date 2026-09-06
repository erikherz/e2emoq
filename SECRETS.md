# Secrets

Nothing here is set yet, and the Worker fails closed without them: it deploys, serves pages and
answers the API, but no broadcast can go live. This is the order to set them in, and the order
matters in one place — see the warning under moq.pro.

Check what is set at any time:

```sh
npx wrangler secret list
```

## 1. The media path — moq.pro

`moqProAssign()` returns non-null the instant `MOQ_PRO_JWK` (or the legacy `MOQ_PRO_K`) exists,
and both `/route` and the publish handler take that branch first. This secret is **required**:
without it there is no CDN to publish to and going live fails.

> **Check what is actually set, not what the config suggests.** `wrangler secret list` is the
> answer; secrets are write-only, so nothing on disk records which key is live.

**Use the asymmetric key, not `MOQ_PRO_K`.** With the JWK, moq.pro holds only the public half:
it can verify our tokens and cannot mint one. `MOQ_PRO_K` is a shared symmetric secret the CDN
also holds, so anything that reads it can issue tokens as us.

**⚠ ORDER MATTERS AND IT IS EASY TO GET WRONG.** The moment `MOQ_PRO_JWK` exists, *every*
broadcast routes to `cdn.moq.pro` — so if the public half is not registered there yet, they all
fail. Generate to a file first, register, then set the secret. That is what `--out-file` is for.

```sh
cd ~/Desktop/git/e2emoq

# Generates an Ed25519 keypair, stamps both halves with the RFC 7638 thumbprint as `kid`,
# writes the PRIVATE half to moqpro.jwk (chmod 600) and prints ONLY the public half.
node scripts/moq-keygen.mjs --secret MOQ_PRO_JWK --out-file moqpro.jwk
```

Register the printed public JWK at **moq.pro → Keys → Add Key** ("Import Asymmetric"). Then:

```sh
cat moqpro.jwk | npx wrangler secret put MOQ_PRO_JWK
rm moqpro.jwk
```

Two things that will silently break this:

- **The `kid` must match** what moq.pro shows for that key. The minter stamps `kid: jwk.kid`
  (`src/worker/auth/moq-token.ts:154`) and the CDN selects its verifying key by it. The keygen
  handles this; a hand-made key will not.
- **Ed25519 only.** `mintMoqProTokenEd25519()` hardcodes `{name: "Ed25519"}` and `alg: "EdDSA"`,
  so an ES256 key registered at moq.pro cannot be used without new code.

**Generate a NEW key — do not reuse Wallflower's.** One key across two products means either
Worker's compromise forges tokens for the other. It is also not recoverable: Cloudflare secrets
are write-only, so a key that exists only as a deployed secret is gone.

### The namespace, which is a decision rather than a default

`MOQ_PRO_ROOT` is unset, so this deployment shares the default `erik` root with Wallflower —
and, if it is still on moq.pro, with vivoh.earth. Tokens are scoped to a single `<id>.hang`, so
this only bites on a **stream-id collision** between two products sharing the root: ids are 5
characters of `[a-z0-9]`, so a collision is ~1 in 60 million per pair, and what it would reach
is ciphertext this side cannot decrypt anyway.

That was an acceptable trade for two products. Three is a different number. If moq.pro will
give you a second root:

```sh
printf '%s' 'e2emoq' | npx wrangler secret put MOQ_PRO_ROOT
```

## 2. Publisher admission

Two independent checks, answering different questions (`src/worker/index.ts:2101`):
**admission** — may you publish at all — and **ownership** — is this broadcast name yours. Only
admission needs a secret; ownership is an Ed25519 challenge against a keypair the browser mints
per broadcast.

```sh
# The HMAC key that seals self-serve publish codes. Set this and a broadcaster's browser mints
# its own code behind the proof of work (PUBLISH_CODE_POW_BITS=18, ~0.5s). Leave it unset and
# the whole code path is off, so PUBLISH_SECRET becomes the only door.
printf '%s' "$(openssl rand -base64 32)" | npx wrangler secret put ISSUE_KEY

# HMAC key for stateless publish challenges. Separate from the two above so that leaking a
# challenge can never reveal an admission credential.
printf '%s' "$(openssl rand -base64 32)" | npx wrangler secret put CHALLENGE_SECRET
```

Those two are machine-only — no human ever types them, so generate and forget.

The next two you must **record in your password manager**, because you will need to type them:

```sh
# The shared admission credential. Not an account: one value, identifies nobody, never written
# down on this side. Rotating it revokes every broadcaster at once.
npx wrangler secret put PUBLISH_SECRET

# Bearer for /api/admin/*. Unset => the admin API is disabled entirely, which is why
# /api/admin/reports currently answers 503 rather than 404.
npx wrangler secret put ADMIN_PASSWORD
```

`wrangler secret put` with no stdin prompts for the value and does not echo it.

## 3. Leave unset

| Secret | Why |
|---|---|
| `MOQ_PRO_K` | the legacy **symmetric** moq.pro secret, which the CDN also holds — meaning it could mint tokens as you. Setting it alongside the JWK is harmless (the JWK wins) but pointless, and setting it *instead* is a downgrade |
| `MOQ_PRO_KID` | an override for the key id. moq.pro adopts the `kid` from the imported JWK, so this is not needed |

`REPORT_WEBHOOK` and `REPORT_FRAME_RETENTION_DAYS` are gone with the reporting feature and are
no longer read anywhere.

## 4. Verify

```sh
npx wrangler secret list          # MOQ_PRO_JWK, ISSUE_KEY, CHALLENGE_SECRET, PUBLISH_SECRET, ADMIN_PASSWORD
curl -s https://e2emoq.com/api/pubkey | head -c 200
```

`/api/pubkey` answers 503 on this deployment, and that is correct — it serves a key this
configuration does not use. The real check is a broadcast: open `/broadcast`, go live, and
confirm the relay is `cdn.moq.pro`.

## Rotating the key

Register the **new public half** at moq.pro first, then replace the secret:

```sh
cat new-moqpro.jwk | npx wrangler secret put MOQ_PRO_JWK
```

Effective on the next request — no deploy, no build. Do it in that order: the moment the secret
changes, every broadcast is signed with the new key, and an unregistered key connects fine and
dies the instant it speaks MoQ. Leave the old key enabled at moq.pro until live broadcasts have
drained, then disable it.

**Do not `secret delete MOQ_PRO_JWK`** expecting a fallback. There is no other media path
configured; deleting it takes broadcasting down.
