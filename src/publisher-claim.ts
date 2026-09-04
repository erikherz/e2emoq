// Proving you may publish, and that a broadcast name is yours.
//
// Two separate things travel to the Worker at go-live:
//
//   publish key — a shared admission credential. It says "this person is allowed to
//                 broadcast" and nothing else. It is not an account, identifies nobody, and
//                 is the same value for every broadcaster.
//
//   signed claim — proof that we hold the private half of the key naming this broadcast.
//                 The keypair is minted here, per broadcast, and the private half is
//                 non-extractable and never leaves the page. Only a signature travels.
//
// Together they answer "may you publish?" and "is this name yours?" without an account, an
// email address, or anything that could identify a broadcaster across broadcasts.

const CLAIM_CONTEXT = "e2emoq-claim-v1";
const STORAGE_KEY = "e2emoq.publishKey";

const bytesToB64url = (b: ArrayBuffer | Uint8Array): string => {
  const u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
  return btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/**
 * The admission credential, from `?pk=` (which we then remember) or from a previous visit.
 * Kept in localStorage so a broadcaster pastes it once per device rather than every time.
 */
export function getPublishKey(): string | null {
  const fromUrl = new URLSearchParams(location.search).get("pk");
  if (fromUrl) {
    try { localStorage.setItem(STORAGE_KEY, fromUrl); } catch { /* private mode */ }
    return fromUrl;
  }
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

export function setPublishKey(key: string): void {
  try { localStorage.setItem(STORAGE_KEY, key); } catch { /* private mode */ }
}

export interface PublisherClaim {
  publishKey: string;
  pubkey: string;
  challenge: string;
  signature: string;
}

/**
 * The keypair for the broadcast currently being set up, held only in memory.
 *
 * ONE KEYPAIR PER BROADCAST NAME, not per call. Go-live records this public key on the
 * broadcast row, and every later write that has to prove "same publisher" — stream settings —
 * signs a fresh challenge with the SAME private key so the Worker can compare them. Minting a
 * new pair per call would produce a different public key each time and no such write could
 * ever be recognised as the publisher's.
 *
 * Keyed by streamId so rotating the link ("New link") starts a genuinely new identity, which
 * is what keeps a broadcaster's streams unlinkable to anyone watching public keys. Never
 * persisted: a reload deliberately loses it, exactly like the private half itself.
 */
let heldPair: { streamId: string; pair: CryptoKeyPair; pubkey: string } | null = null;

/**
 * Mint (or reuse) this broadcast's keypair, fetch a fresh challenge, and sign it. Returns null
 * when no publish key is available or the Worker declines to issue a challenge — callers must
 * treat that as "not authorized to broadcast" rather than proceeding unsigned.
 *
 * The CHALLENGE is always fresh even when the keypair is reused, so a captured signature
 * cannot be replayed.
 */
export async function buildPublisherClaim(streamId: string): Promise<PublisherClaim | null> {
  const publishKey = getPublishKey();
  if (!publishKey) return null;

  let challenge: string;
  try {
    const r = await fetch("/api/publish/challenge");
    if (!r.ok) return null;
    challenge = (await r.json()).challenge;
    if (!challenge) return null;
  } catch {
    return null;
  }

  if (!heldPair || heldPair.streamId !== streamId) {
    // extractable = false: the private key cannot be read out of the browser, by us or by any
    // script running on the page. (The PUBLIC half stays exportable regardless — that flag
    // governs the private key, which is the one that matters here.)
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    const rawPub = await crypto.subtle.exportKey("raw", pair.publicKey);
    heldPair = { streamId, pair, pubkey: bytesToB64url(rawPub) };
  }

  const msg = new TextEncoder().encode(`${CLAIM_CONTEXT}|${streamId}|${challenge}`);
  const sig = await crypto.subtle.sign("Ed25519", heldPair.pair.privateKey, msg);

  return {
    publishKey,
    pubkey: heldPair.pubkey,
    challenge,
    signature: bytesToB64url(sig),
  };
}
