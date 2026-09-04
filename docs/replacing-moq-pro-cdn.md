# Replacing cdn.moq.pro with our own relays

**Status:** not done, not scheduled. This is a feasibility note, written 15 August 2026
against the tree at `8fb2f6f`.

**Short version:** the self-hosted TinyMoQ fleet path was never removed. moq.pro was layered
*on top* of it as "Mode A", gated on one secret, and both paths are live in the code today.
Switching back is `wrangler secret delete` — no code change, no deploy, no schema change.

The catch is not the switch. It is that **the kill switch stops being enforceable**, because
viewer-token renewal was only ever implemented for the moq.pro path. That is the whole
decision. Everything else here is detail.

Line numbers are a snapshot; the symbol names are the durable anchors.

---

## 1. The flip

```
wrangler secret delete MOQ_PRO_JWK
wrangler secret delete MOQ_PRO_K
```

That is the entire mechanism. It works because the migration was built to be reversible at
runtime:

- `moqProAssign()` (`src/worker/index.ts:1090`) returns `null` when neither `MOQ_PRO_JWK`
  nor `MOQ_PRO_K` is set.
- Both call sites fall straight through to the fleet path — viewer `/route`
  (`index.ts:725`) and broadcast-start (`index.ts:1563`).
- The client branches on whether the Worker returned a `path` field: publisher
  (`main.ts:1460`), viewer (`main.ts:2557`). No `path` → the fleet connect form,
  `https://<relay>/?jwt=<token>` with `name=<broadcastName>`.

`wrangler.jsonc` still carries working fleet config (`FLEET_MODE: "brokered"`,
`FLEET_ENDPOINT: "https://moqcdn.net/cdn/assign"`), so there is nothing to restore.

### Correction to the record

Commit `c4624cb` instructs `git checkout e2emoq-pre-moqpro` for a full revert. **That
branch does not exist** — only `moqpro-migration` does. It also references a `rollback.md`
that is not in `docs/`. The secret-unset above is the real rollback, and it is better than a
branch revert anyway: it needs no deploy and no DB restore (the migration deliberately kept
the `content_key` column shape additive for exactly this).

---

## 2. TinyMoQ or bare moq-relay?

Use the TinyMoQ fleet. It is not merely "some relays" — it is the control-plane contract the
Worker was written against:

| What the Worker calls | Provided by |
|---|---|
| `/assign` → `{relay: "host:port", key, byok}` | TinyMoQ box (direct) or broker (brokered) |
| `/release` on broadcast end | TinyMoQ box |
| JWT verification with `put`/`get` scopes + `exp` | TinyMoQ box |
| Cross-cluster pull (edge pulls origin) | TinyMoQ, via the `cluster` claim |

Bare `moq-relay` gives you rows 3 and 4 outright — clustering is native (`[cluster]`, see §6),
and JWT verification is the same code moq.pro runs. Rows 1 and 2, and the autoscaling behind
them, are what TinyMoQ *is*. Spinning up our own moq-relay servers therefore makes sense
*behind* TinyMoQ's control API, not instead of it — the relay is the easy half.

The `/assign` response is dual-mode and cutover-safe (documented at `index.ts:1148`):

- bare text `"host:port"` → sign with the tenant key
- JSON `{"relay","key","byok"}` → managed (`key` is a per-stream HMAC secret) or BYOK
  (`key: null`, `byok: true`)

**Do not cache the managed key.** `/assign` is sticky, but a reap/respawn yields a new key —
which is also what makes managed mode self-revoking.

### Credentials

| Mode | `FLEET_MODE` | `FLEET_ENDPOINT` | Credential |
|---|---|---|---|
| Direct (we operate the box) | `direct` | box base URL | `TINYMOQ_PROVISION_KEY` |
| Brokered (operator selects the box) | `brokered` | broker's full assign URL | `CDN_API_TOKEN` |

In brokered mode `TINYMOQ_PROVISION_KEY` must **not** be set — the box bearer stays with the
operator, and leaking it into the customer app defeats the point of the brokered path.

### Token signing

- **BYOK / EdDSA (preferred).** Set `MOQ_AUTH_PRIVATE_JWK`; register only its public half as
  the box's `verify_jwk`. `GET /api/pubkey` (`index.ts:242`) serves that public JWK as plain
  JSON to paste into the CDN console — it never exposes the private half. The relay can then
  verify our tokens and cannot mint one.
- **Managed / HS256.** No tenant key; sign each broadcast with the `key` that `/assign`
  returned (`mintHs256Token`).

Check `key mode` on the actual box rather than inferring it from config. That has caused a
wrong conclusion before.

---

## 3. What does NOT change

**Encryption.** The migration commit dropped relay-blind E2E on the moq.pro path, but it came
back as link-fragment-derived keys and is now transport-agnostic. The content key is installed
*before* either connect branch (`main.ts:1454`), and the fleet branch is explicitly documented
as identical. Switching relays does not touch the encryption story at all.

Worth stating plainly, though: on our own boxes "relay-blind" stays literally true but stops
being the interesting claim. The point of relay-blind was that *someone else's* CDN cannot
read the media. Owning the relay does not weaken the property — it moves the trust to where it
already sat.

**Everything Worker-side.** Chat (Durable Objects), passcodes, publisher claim, publish codes,
reports, the new-link rotation, first-claim-wins on stream ids. None of it touches the relay.

**Client protocol.** `@moq/publish` 0.2.15 / `@moq/watch` 0.2.17 / `@moq/net` 0.1.5,
negotiating moq-lite-04. These are byte-identical before and after the migration
(`git show c4624cb^:package.json`), so there is no client-side drift to unwind. Confirm the
boxes still negotiate moq-lite-04 rather than assuming it — that is the classic failure on a
dormant path.

---

## 4. What regresses: the kill switch

This is the real cost and it should drive the decision.

### The claim today

`kill-enforcement.mjs` documents the chain that makes termination enforceable rather than
merely requested:

1. cdn.moq.pro drops a session at token expiry — **measured**, not assumed
   (`token-expiry.mjs`: a 30s token stalls at 30–40s while the publisher keeps sending)
2. renewal must come back through this Worker
3. the Worker returns 410 for a killed stream, so no new token is issued

So a client that ignores the `killed` flag entirely — or never ran our JavaScript — still
stops within one token lifetime. `VIEWER_TOKEN_TTL_RENEWED = 120` is the hard ceiling on that.

### Why it breaks on the fleet path

Three facts, all verifiable in the tree:

- `VIEWER_TOKEN_TTL_RENEWED` (120s) is commented **"The moq.pro path only, where the client
  DOES renew"** (`index.ts:1362`).
- The brokered viewer token is minted at `now + VIEWER_TOKEN_TTL` — **6 hours**
  (`index.ts:762`). `VIEWER_TOKEN_TTL`'s own comment says it is the lifetime used by the
  fleet/brokered and enterprise paths "whose clients do not implement renewal."
- The client agrees: `main.ts:2645` logs `"[token] renewal only implemented for the moq.pro
  path"`.

So on the fleet path a viewer holds a **6-hour** token and nothing renews it. A client
ignoring the kill flag keeps watching for up to six hours. Kill degrades to cooperative.

### And the test harness cannot measure it as-is

`token-expiry.mjs` works by passing `?ttl=<short>` to `/route`. That override is parsed into
`viewerTtl` and then used **only in the moq.pro branch** (`index.ts:715–740`); the brokered
branch below it ignores `viewerTtl` and hardcodes `VIEWER_TOKEN_TTL`. Pointing the existing
test at a fleet deployment would silently measure a 6h session and prove nothing.

This is a stronger statement than "we would need to re-measure": the measurement does not
work on that path yet.

### The good news: mid-session expiry is upstream behaviour, not a moq.pro feature

Upstream `doc/bin/relay/auth.md` states it directly:

> The `exp` claim is enforced for the whole session, not just at connect time. The relay
> closes the connection once `exp` passes, so a client must reconnect with a fresh token to
> continue. The same applies to mTLS: the connection is closed when the client certificate's
> `notAfter` is reached.

So the property that makes our kill switch enforceable is `moq-relay`'s documented
behaviour, and **cdn.moq.pro is simply a moq-relay deployment exhibiting it**. Running our
own relays does not forfeit it. `token-expiry.mjs` measured moq.pro and, in doing so,
measured moq-relay.

That reframes this section: the risk is not "will our relay enforce expiry" but "our
*client* stops asking for short tokens on the fleet path." The gap is entirely on our side.

### What it would take to keep kill enforceable

1. Honour `?ttl=` in the brokered/direct branch so `token-expiry.mjs` can measure at all.
2. Confirm the pinned build (`02273a0b`) behaves as upstream documents. Documented-on-main
   is strong evidence, not proof, for a relay pinned months earlier — and this is the one
   claim in the trust story worth re-measuring rather than inferring.
3. Wire renewal for the fleet path. The client seam already exists: `scheduleRenewal` reads
   the token's own `exp`, so it activates the moment TTLs drop — no new client mechanism.
4. Lower the fleet viewer TTL from 6h to `VIEWER_TOKEN_TTL_RENEWED` (120s).

Only if step 2 comes back negative does kill degrade to cooperative, and only then do
`public/trust.html` and the security architecture doc need their termination language
re-read — before the switch, not after.

Ordinary viewers are unaffected either way — they stop within ~5s via the kill flag with the
transport closed (`kill-transport-close.mjs`). This path only ever governs someone who went
out of their way to keep watching.

---

## 5. Smaller items

- **Safari / WebSocket fallback.** `FALLBACK_RELAYS` (`main.ts:86`) is pinned to a single box,
  `cdn.gpcmoq.com`, probed at `:8888/fingerprint`, with the comment "Pinned to the single test
  box for the full end-to-end test (no prod traffic)." That is stale test config on the
  iPhone/Safari path and needs updating to the real fleet before any switch.
- **Geo coverage becomes ours.** The cross-fleet machinery is intact — the brokered `/route`
  hands the broker the origin `host:port` plus a subscribe-scoped pull token, and the broker
  either serves direct or makes a geo-near box cluster-pull the origin. But "is there a box
  near this viewer" stops being someone else's problem.
- **Dormancy.** The fleet path has carried no traffic since 6 August 2026 (`c4624cb`), and the
  DHT removal (`36a6166`) touched Worker routing since. It typechecks; it has not been run
  end to end.
- **Billing/abuse posture is unchanged in shape.** `PUBLISH_SECRET`'s comment frames it as
  protecting bandwidth billed to our moq.pro tenant. On our own fleet the bandwidth is still
  ours — same exposure, different invoice.

---

## 6. An example `relay.toml`

`moq-relay` takes **one positional argument: the path to a TOML file**
(`moq-relay relay.toml`). The Debian/RPM packages drop `/etc/moq-relay/relay.toml`
alongside a systemd unit.

Everything below is from upstream `moq-dev/moq` `main` as of 15 August 2026
(`doc/bin/relay/config.md`, `doc/bin/relay/auth.md`, `demo/relay/*.toml`). **See the
version caveat at the end of this section before copying it onto a box.**

```toml
# e2eMoQ origin relay — BYOK EdDSA, no anonymous access.

[log]
level = "info"                        # RUST_LOG takes precedence

[server]
bind = "[::]:443"                     # QUIC / WebTransport (UDP)

[server.tls]
cert = "/etc/moq/cert.pem"
key  = "/etc/moq/key.pem"
# root = ["/etc/moq/peer-ca.pem"]     # see "clustering" below

# TCP fallback — this is the Safari/WebSocket path the client races today.
[web.https]
listen = "[::]:443"
cert   = "/etc/moq/cert.pem"          # may be the same pair as server.tls
key    = "/etc/moq/key.pem"

# Debug/plaintext HTTP: serves /certificate.sha256, /announced/*, /fetch/*.
# Leave it off in production unless something needs the fingerprint.
# [web.http]
# listen = "[::]:8080"

# Operational endpoints: /health, /metrics (Prometheus), /nodes. Loopback only.
[internal]
listen = "127.0.0.1:9101"

[auth]
# BYOK. The relay holds ONLY the public half and mints nothing.
#
# Single key — paste the output of `GET /api/pubkey` into this file:
key = "/etc/moq/keys/e2emoq.jwk"
#
# Or key rotation by `kid`: the relay reads the JWT header's kid and fetches
# {key_dir}/{kid}.jwk. Works against a directory OR a URL:
# key_dir = "/etc/moq/keys/"
# key_dir = "https://e2emoq.com/keys"
#
# No `public` key at all => authentication required everywhere, which is what
# we want. `public = ""` makes the whole relay anonymous (dev only).

[stats]
enabled = true
node = "sjc/1"                        # disambiguates per-relay stats in a cluster

[iroh]
enabled = false                       # not needed; see §10 of federation-roadmap
```

### How our existing tokens line up

They already are upstream tokens. No translation layer is needed:

| Upstream claim | What `moq-token.ts` mints |
|---|---|
| `root` — base path (optional) | omitted by `mintEd25519Token`; `"erik"` by the moq.pro minter |
| `put` — publish suffixes | `put: [broadcastName]` for publishers, `[]` for viewers |
| `get` — subscribe suffixes | `get: [broadcastName]` |
| `exp` — unix seconds | `now + TTL` |

Upstream notes that `get` is spelled that way because `sub` is a reserved JWT claim —
which is why our field names have always looked slightly odd. Path matching is
`root + "/" + suffix`, an empty suffix grants everything under the root, and suffixes
match on **path boundaries** (`foo` grants `foo` and `foo/bar`, never `foobar`).

`EdDSA` is a supported verification algorithm, so `MOQ_AUTH_PRIVATE_JWK` works as-is and
`GET /api/pubkey` (`index.ts:242`) already emits exactly the JWK this config wants.

Two upstream features worth knowing about, neither currently used:

- **`key_dir` accepts a URL.** The relay fetches `{url}/{kid}.jwk` on demand. Serving
  `/keys/<kid>.jwk` from the Worker would make key rotation a deploy rather than a box
  visit. Our `kid` is an RFC 7638 thumbprint, which satisfies the relay's
  alphanumeric/`-`/`_` constraint.
- **Scoped keys.** A JWK can embed immutable `scope: {root, put, get}` limits, and the
  library *rejects the whole token* rather than silently intersecting when a token exceeds
  them. Scoping our key to our own root would mean a Worker compromise still could not
  publish outside it.

### Clustering (only if we run more than one box)

```toml
[cluster]
connect = ["https://sjc.example.com/?jwt=..."]   # peers this relay dials
node    = "ams.example.com:443"                  # our own reachable URL
mesh    = true                                   # gossip discovery; needs `node`
# connect_api = "https://e2emoq.com/cluster/peers"   # peer list over HTTP
# token = "cluster.jwt"                          # outbound dial JWT (or use mTLS)
linger  = "5s"                                   # broadcast survives publisher blip
```

**mTLS is the better answer for peer auth.** Set `server.tls.root` to a CA and any peer
presenting a cert chaining to it gets full access scoped to the connection path — a peer
dialing `/` gets cluster-wide access. That is likely to remove the `&pull=` token juggling
described in `federation-roadmap.html` §9, and it sidesteps the `--cluster` claim that
`moq-token-cli` 0.5.29 could not emit without a local patch.

Note `--cluster-root` and `--cluster-node` were **removed** upstream; a relay errors at
startup if either is set.

### Version caveat — read this before deploying

This is upstream `main`, and our fleet is **not** on upstream main:

- Our relays are pinned at commit `02273a0b`, and `moq-token-cli` at 0.5.29.
- Our browser client negotiates **moq-lite-04**. Upstream docs now discuss moq-lite-05 and
  `moq-transport-16`, and `[server] version` exists to pin accepted versions.
- `demo/relay/prod.toml` still shows `[server] listen` while `doc/bin/relay/config.md`
  documents `[server] bind`. The config reference is the newer of the two; a pinned older
  build may want `listen`. Check which one the box's actual binary accepts rather than
  trusting either file.
- `[server.tcp]`, `[server.unix]`, `[internal]`, `auth_api`, and `stats.tier` all read as
  recent additions and may simply not exist in a build from `02273a0b`.

Treat the block above as the shape of a correct config, not as something to paste onto a
pinned box unread.

---

## 7. Verification checklist

Against a deployed origin (there is no pre-deploy environment — deploy, test, roll back):

| Suite | Proves |
|---|---|
| `broadcast-watch.mjs` | the fleet connect form works end to end at all |
| `token-expiry.mjs` | **blocked** until `?ttl=` is honoured on the brokered path (§4) |
| `kill-enforcement.mjs` | kill survives a non-cooperative client — the decision point |
| `kill-live-viewer.mjs`, `kill-transport-close.mjs` | the cooperative path still works |
| `passcode.mjs`, `encrypted-negative.mjs` | encryption unaffected by the transport change |
| `chat-e2e.mjs`, `publisher-auth.mjs`, `publish-code.mjs` | Worker-side, expected untouched |
| `new-link.mjs` | rotation still ends the old broadcast on a fleet relay |

All of these need `WF_PUBLISH_KEY` in the environment. A run that fails with "never went live"
is usually a missing key, not a broken deployment.

---

## 8. Recommendation

Reversing the transport is genuinely one command, and the fleet code is in better shape than
its dormancy suggests. But do not treat it as a config flip: on the current tree it silently
converts an *enforceable* kill switch into a *cooperative* one with a six-hour tail, and the
test that would have caught that cannot run on the fleet path.

The token layer is not the obstacle it might look like. `moq-token.ts` already mints upstream
`moq-relay` tokens — same `root`/`put`/`get`/`exp` claims, an already-supported algorithm,
and a public JWK the Worker already serves. What moq.pro adds on top is an account namespace
and someone else's operations team, not cryptography we would have to rebuild.

Sequence it as: honour `?ttl=` → confirm the pinned build enforces `exp` mid-session → wire
fleet-path renewal → drop the TTL. Steps 1 and 2 are cheap and settle whether the rest is
worth doing.
