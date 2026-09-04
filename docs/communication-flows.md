# Communication Flows & Privacy

*Status: working reference (actively evolving). Companion to `trust-model.md` (who-can-see-what)
and `security-architecture.html` (content encryption).*

This document traces the **wire-level messages** between the e2eMoQ app, the two browser
roles (broadcaster / watcher), the backend (broker + fleet), and the **chat** channel — with a
privacy annotation on every hop, so we can see exactly **how a user could be identified,
targeted, or revealed**, and where they're protected. The bar for e2eMoQ is very high, so
this is written to expose leaks, not to reassure.

> **Headline:** the tokens and the media path are clean, but **precise geolocation (lat/lon) is
> captured server-side and persisted in D1 for both broadcasters and viewers**, and one endpoint
> (`GET /api/stats/stream/:id/viewers`) **re-exposes every viewer's stored geo publicly**. That
> is the single biggest deanonymization surface today. Details in §6.

---

## 1. Global facts (apply to every flow)

- **OAuth is disabled → there is no account identity.** `getAuthenticatedUser()` returns a
  hardcoded anonymous user (`id:1`, `anonymous@e2emoq.com`) — `src/worker/index.ts:1459`,
  `src/auth.ts:25`. Every `user_id` written is `1`. The Google OAuth exchange is commented out.
- **Every browser→Worker call is a Cloudflare request**, so Cloudflare (and the Worker) always
  sees the caller's **IP** and `request.cf` (lat/lon/city/region/country/colo/**asn**/
  asOrganization) — even when the JSON body carries no identity. This is transitively true for
  all `/api/*` flows.
- **Tokens are clean.** `MoqClaims = { put:[], get:[<broadcastName>], exp, cluster? }`
  (`src/worker/auth/moq-token.ts:43`). **No IP, geo, email, or account id in any token** — only
  the pseudonymous stream id and an expiry.

---

## 2. The five channels

```mermaid
flowchart TB
  BC[Broadcaster browser]
  VW[Watcher browser]
  W[e2eMoQ Worker + D1 + Durable Objects]
  K[Broker moqcdn.net/cdnadmin]
  R[Fleet relay box]
  BC -- "1 control (IP+geo→D1)" --> W
  VW -- "2 control (IP+geo→D1, geo→broker)" --> W
  BC -. "3 chat WS (plaintext→DO)" .- W
  VW -. "3 chat WS (plaintext→DO)" .- W
  W  -- "4 assign (geo hints, no viewer IP)" --> K
  BC == "5 media WT (browser IP → box)" ==> R
  R  == "5 ciphertext fan-out" ==> VW
```

1. **Control plane** — browser ↔ Worker (`/api/*`). Carries IP + precise geo; some persisted.
2. **Broker plane** — Worker ↔ broker. Server-to-server; carries forwarded precise geo, no IP.
3. **Chat plane** — browser ↔ per-stream Durable Object (WebSocket). Plaintext; **separate from
   media and from the relay**.
4. **Media plane** — browser ↔ relay box (WebTransport). Box sees the **browser IP**; media is
   ciphertext (fleet flow).

> **Resolved 2026-08-15 — the discovery plane is gone.** This document previously carried a
> fifth plane: browser ↔ public pkarr relays, which exposed the browser IP and the nodeId being
> published or looked up to third-party infrastructure outside Cloudflare. The DHT path was
> removed from e2eMoQ entirely, so **no browser contacts a pkarr relay and no record about
> any broadcast is published anywhere public.** The two ⚠️ findings below are closed.

---

## 3. Flow inventory (with privacy annotations)

### Group A — Broadcaster browser ↔ Worker

| Flow | Endpoint (file:line) | Payload | Privacy |
|---|---|---|---|
| Go-live | `POST /api/stats/broadcast` (`auth.ts:81`) | `{stream_id, publisher_cdn}` + optional `?geo=` | **IP** (cf). **Precise geo captured server-side from `request.cf` and stored in D1 `broadcast_events`** (`index.ts:1344,1364`). Returns pub JWT + **content key**. |
| End | `POST /api/stats/broadcast/:id/end` (`auth.ts:168`) | none (event id in path) | IP (cf). No geo/token. |
| Stream settings | `GET/POST /api/streams*` (`auth.ts:200,217,235`) | stream id + flags (`require_auth`, `encrypted`, `chat_enabled`) | IP (cf). Pseudonymous stream id only; `user_id=1`. |

### Group B — Watcher browser ↔ Worker

| Flow | Endpoint (file:line) | Payload | Privacy |
|---|---|---|---|
| Route (fleet) | `GET /api/streams/:id/route` (`auth.ts:132`) | query: `viewer-cdn, origin, xport, geo` | **IP** (cf). Worker reads **ASN + AS-org** (`index.ts:682`); in brokered mode **forwards precise viewer geo to the broker**. Returns viewer/pull JWT + **content key** (withheld to non-signed-in on auth-gated streams). |
| Watch start | `POST /api/stats/watch` (`auth.ts:176`) | `{stream_id}` | **IP** (cf). **Precise viewer geo captured server-side and stored in D1 `watch_events`** (`index.ts:1428`). |
| Watch end | `POST /api/stats/watch/:id/end` (`auth.ts:191`) | none | IP (cf). |
| Live stats | `GET /api/stats/live` (`auth.ts:280`) | — | **Re-exposes stored precise geo** of all broadcasts+viewers (and email/name if OAuth were on). |
| Per-stream viewers | `GET /api/stats/stream/:id/viewers` (`auth.ts:290`) | — | ⚠️ **PUBLIC.** Anyone with a stream id reads **every viewer's stored precise geo** (`index.ts:1257-1321`). |

### Group C — Worker ↔ broker / fleet

| Flow | Endpoint (file:line) | Payload | Privacy |
|---|---|---|---|
| Brokered assign | `POST <broker>/cdn/assign` (`index.ts:1124`) | `{broadcast, origin?, pull?, xport?, hints}`; `hints=brokerHints()` | **No viewer IP** (Worker-origin), but **deliberately re-injects precise viewer geo** `{lat,lon,country,colo}` (`index.ts:1024`). Auth = `CDN_API_TOKEN` (tenant, not user). Broadcast name pseudonymous. |
| Direct assign/release | `GET <box>/assign\|/release` (`index.ts:1073,1205`) | broadcast name | Server-to-server; **no geo/IP forwarded** in direct mode. Provision bearer (tenant secret). |
| Origin EID lookup | `GET <box>/iroh?port=` (`index.ts:990`) | — | Server-to-server; no user data. |

### Group D — Browser ↔ relay (WebTransport) — *box sees the real browser IP*

| Flow | Connect URL (file:line) | Privacy |
|---|---|---|
| Publisher connect | `https://<relay>/?jwt=` (`main.ts:1247`) | **Relay/box sees broadcaster IP.** Token = stream id scope, no identity. |
| Viewer connect | `https://<relay>/?jwt=` (`main.ts:2177`) | **Edge box sees viewer IP.** Subscribe token, stream id scope only. |
| Enterprise (Mode C) | `/assign` + connect (`main.ts:1582,1598`) | **Private relay sees viewer IP.** Watch + browser-couriered pull token. |
| Probes | `:8888/fingerprint`, `/edge_xport` (`main.ts:432,577`) | Direct browser→box: box sees browser IP; no token. |

### Group E — Browser ↔ discovery — **REMOVED 2026-08-15**

This group no longer exists. It covered the node-id flow: `POST /api/publish`, `POST /api/edge`,
and the `Pkarr.relayPut` / `relayGet` calls in `dht.ts`. Every one of those code paths has been
deleted — `dht.ts` and `nodeid.ts` are gone from the tree, the two Worker routes are gone, and
`pkarr` is no longer a dependency. **The browser now contacts no third party outside Cloudflare
and the fleet box.**

Closed with it: the un-encrypted node-id media path (there is no longer any path that publishes
plaintext), and the world-readable `nodeId → origin EndpointId` record.

### Group F — Admin (not a normal-user flow)

| Flow | Endpoint (file:line) | Privacy |
|---|---|---|
| Admin | `/api/admin/*` (`main.ts:2692…`, `index.ts:1511`) | ⚠️ Auth is a **hardcoded admin bearer** in source (`index.ts:1508`) — a static shared password, not per-user, and a real security weakness (should be a Worker secret). Responses can include **email addresses**. |

---

## 4. Chat — the separate plaintext channel

Chat lives in `src/worker/chat-room.ts` (Durable Object), `src/chat/chat-client.ts` (browser),
route at `index.ts:475`. It is **completely separate from the media path and the relay.**

- **Transport:** WebSocket `wss://<host>/api/streams/<id>/chat` → one **Durable Object per
  stream** (Hibernation API). Fan-out to all connected sockets (`chat-room.ts:66`).
- **Message on the wire:** client sends `{type:"msg", name, text}`; the DO stamps
  `{id:uuid, name, text, ts}` (`chat-room.ts:60`). **No user id, token, pubkey, stream id, or IP
  in the message.**
- **Identity = a self-chosen, spoofable display name.** **No authentication required to chat**
  (the route checks only `chat_enabled`, not `require_auth`/login). Anyone can chat anonymously
  under any name. ⚠️ **Footgun:** if a user is signed in, the client **pre-fills their real
  `user.name`** into the handle (`chat-client.ts:22`) — they may broadcast their real name
  unknowingly.
- **Storage:** the **last 50 messages persist in Durable Object storage** with **no TTL and no
  deletion when the broadcast ends** (`chat-room.ts:61`). New joiners receive that history.
- **Who reads it:** **plaintext, server-visible.** Cloudflare (the DO operator) and the
  broadcaster see **100% of message content and claimed names**. The **relay never sees chat**.
  It is **not** covered by the media AES-GCM encryption.
- **IP/metadata:** Cloudflare sees the socket's IP at the edge, but the chat code **never reads,
  logs, or stores it**; messages carry no IP. Presence is a live socket count only (no roster).

---

## 5. What actually identifies a user

Only these exist in the whole system:

1. **IP + Cloudflare geo/ASN** — ambient on every browser→Worker and browser→relay call.
   The real deanonymizer.
2. **Precise geo (lat/lon)** — captured server-side and **persisted in D1** for broadcasters
   (`broadcast_events`) and viewers (`watch_events`), and **re-exposed** (one endpoint publicly).
3. **Stream id** — pseudonymous; identifies a *stream*, not a person (unless linked
   elsewhere).
4. **Chat display name** — self-chosen; a self-doxxing vector (esp. the auto-filled real name).
5. **Email addresses** — only on the admin surface; inert for normal users (OAuth off).
6. **Tokens carry none of the above** — clean.

---

## 6. How a user gets revealed — ranked exposures

**HIGH — persisted precise geolocation, one endpoint public.**
Lat/lon is captured from `request.cf` and stored in D1 for **both** broadcasters
(`broadcast_events`) and viewers (`watch_events`), then re-exposed by `GET /api/stats/live` and —
critically — the **public** `GET /api/stats/stream/:id/viewers`. **Anyone holding a stream id can
read the precise stored location of everyone who watched it.** This is the top deanonymization
risk and it is live today.

**HIGH — precise viewer geo deliberately forwarded to an external broker.**
`brokerHints` sends `{lat,lon,country,colo}` to moqcdn.net/cdnadmin on every brokered assign,
even though the Worker→broker hop wouldn't otherwise reveal the viewer.

**MEDIUM — raw browser IP exposed to third-party infrastructure.**
Direct browser→relay connections (media plane) show the **untrusted fleet box** the viewer's/
broadcaster's real IP alongside the pseudonymous stream id (network floor). *Partly resolved
2026-08-15:* the pkarr half of this finding is gone — no browser contacts a public DHT relay any
more, so no third party outside Cloudflare and the fleet box sees an IP↔content linkage. The
network floor against the fleet box remains, and is what a VPN or Tor addresses.

**MEDIUM — chat plaintext + persistence + name footgun.**
All chat is plaintext to Cloudflare and the broadcaster; the last 50 messages persist with no
expiry or end-of-broadcast deletion; and a signed-in user's real name is auto-filled into the
handle.

**~~MEDIUM — node-id media path is not encrypted.~~ RESOLVED 2026-08-15.**
The node-id path was removed rather than encrypted. There is now exactly one media path and it
is always end-to-end encrypted, so "no plaintext" holds everywhere without exception.

**LOW / operational — admin surface.**
A hardcoded admin bearer (a static password in source) guards endpoints that can return email
addresses. A security weakness to fix regardless of the privacy model.

---

## 7. What already protects users

- **No accounts.** OAuth off → no durable account identity; every user is anon `id:1`.
- **Clean tokens.** No IP/geo/email/account id in any JWT — only a pseudonymous stream id + exp.
- **Relay is content-blind and chat-blind.** Media is ciphertext (fleet flow); chat never
  touches the relay.
- **No IP in tokens, messages, or chat records.** IP is transient at the edges, not bound to
  content in app storage (except the geo-derived-from-IP that *is* stored — see §6 HIGH).
- **Media path carries no geo**; geo lives only in the control plane.

---

## 8. Recommendations (ranked to the high-privacy bar)

1. **Stop persisting precise geo; coarsen to US-state / non-US-country only.** Apply the
   `trust-model.md` §7.1 coarsening at the Worker boundary to **both** `broadcast_events` and
   `watch_events` (drop `latitude/longitude/city/region`; keep a single coarse label). Consider
   **not storing viewer geo at all** — ask whether `watch_events` needs to exist.
2. **Lock down or remove the geo-exposing stats endpoints now.** `GET /api/stats/stream/:id/
   viewers` is public and leaks stored viewer geo; `GET /api/stats/live` exposes it broadly.
   Gate behind the operator, or strip geo from their responses. *(This is a live leak — highest
   urgency.)*
3. **Coarsen the geo forwarded to the broker** (`brokerHints`) to the same state/country label.
4. **Chat:** don't auto-fill the real account name; add a TTL / delete DO storage on broadcast
   end; document that chat is plaintext-to-Cloudflare (or move to an E2E chat later).
5. ~~**Encrypt or retire the node-id media path** so "no plaintext" holds everywhere.~~
   **Done 2026-08-15 — retired.**
6. **Replace the hardcoded admin bearer with a Worker secret** and keep emails off any
   normal-user response.
7. ~~**pkarr IP exposure** (node-id flow): self-host a pkarr relay or proxy the put/get through
   the Worker.~~ **Done 2026-08-15** — resolved by removing the flow, so neither mitigation is
   needed. Cross-fleet routing never depended on it (the broker already places viewers).
8. **Relay IP exposure** is the network floor — the user's own tool (Tor/VPN); can't be removed
   in software. Document it honestly.

---

## 9. Summary — per flow

Legend — IP: peer sees browser IP directly **(Y)** / only via Cloudflare **(cf)** / not at all
**(N)**. Geo: **precise** = lat/lon, **coarse** = country/colo, **N** = none.

| # | Flow | IP | Geo | Token | Account id | Persists? |
|---|---|---|---|---|---|---|
| A1 | go-live `/api/stats/broadcast` | cf | **precise → D1** | returns pub JWT | anon(1) | **geo to `broadcast_events`** |
| A2 | end broadcast | cf | N | N | N | ended_at |
| A3 | stream settings | cf | N | N | anon(1) | flags |
| B1 | route `/api/streams/:id/route` | cf | **precise → broker** + ASN | viewer/pull JWT + key | N | N |
| B2 | watch start `/api/stats/watch` | cf | **precise → D1** | N | anon(1) | **geo to `watch_events`** |
| B3 | live / per-stream viewers | cf | **re-exposes stored geo (one PUBLIC)** | N | anon | reads D1 |
| C1 | broker `/cdn/assign` | N | **precise (hints)** | CDN_API_TOKEN + pull | N | N |
| C2 | direct assign/release | N | N | provision bearer | N | N |
| D1-4 | browser→relay WT connect | **Y (box)** | N | **Y** (stream-scoped) | N | N |
| ~~E1-4~~ | ~~`/api/publish`, `/api/edge`, DHT put/get~~ | — | — | — | — | **removed 2026-08-15** |
| Chat | `/api/streams/:id/chat` WS | cf | N | N | display name | **last 50 in DO, no TTL** |
| Admin | `/api/admin/*` | cf | N | **static admin bearer** | **emails** | — |
