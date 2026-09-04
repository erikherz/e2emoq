/**
 * Getting a publish code without sending the broadcaster to a second page.
 *
 * The code is minted by the WORKER, not here — `mintPublishCode()` signs it with ISSUE_KEY,
 * a server-side secret. All the browser contributes is proof of work. What is true, and is a
 * different claim, is that nothing about the requester is read, logged or stored, and the code
 * itself is stateless: signed rather than saved, so there is no row tying anyone to anything.
 *
 * Why this exists at all: /request was the only door, which made a first broadcast a two-page
 * round trip — read the prompt, click through, read three sections, press a button, wait, copy
 * a string, navigate back, paste it. Every step mechanical; not one of them asked the person a
 * question. Measured against production at 18 bits, the puzzle takes a median of 0.5s on a
 * laptop, 0.8s on a mid phone and 2.6s on a 6x-throttled old one (worst observed 4.1s). That is
 * a button, not a page.
 *
 * /request stays for the case this cannot serve: getting a code onto a DIFFERENT device.
 */

const enc = new TextEncoder();

/**
 * Does SHA-256(challenge|nonce) start with `bits` zero bits?
 *
 * THIS PREDICATE NOW EXISTS THREE TIMES — here, in `powIsValid()` in src/worker/index.ts, and
 * inline in public/request.html, which is a static asset the bundler never sees and so cannot
 * import this. They agree only by hand. Change one, change all three, or every request is
 * rejected with "proof of work is not valid".
 */
async function meets(challenge: string, nonce: string, bits: number): Promise<boolean> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(challenge + "|" + nonce));
  const b = new Uint8Array(buf);
  let seen = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0) { seen += 8; continue; }
    seen += Math.clz32(b[i]) - 24;
    break;
  }
  return seen >= bits;
}

/**
 * Search for a nonce. Yields to the event loop every 1024 attempts: without that the tab is
 * frozen for the whole search and any status text never paints, which reads as a hung page
 * rather than a busy one.
 *
 * Deliberately reports attempts rather than a percentage. The search is geometric, so the
 * spread is enormous — runs at this difficulty finished anywhere between 5,312 and 309,466
 * hashes — and a bar drawn against the *mean* is wrong in both directions: it crawls to 97%
 * and sticks on an unlucky run, and it jumps to done on a lucky one.
 */
export async function solvePow(
  challenge: string,
  bits: number,
  onAttempt?: (tried: number) => void,
): Promise<string> {
  for (let i = 0; ; i++) {
    if (await meets(challenge, String(i), bits)) return String(i);
    if ((i & 1023) === 0) {
      onAttempt?.(i);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
}

export interface PublishCode {
  code: string;
  /**
   * False when PUBLISH_CODE_DELAY_HOURS is set above zero, in which case the code exists but
   * will not admit anyone until `activeAt`. It is 0 today, so this is normally true — but a
   * flow that fetched a code and went straight to "you're set" would, the moment that dial
   * moved, hand someone a credential that fails with no explanation. The caller must say so.
   */
  activeImmediately: boolean;
  activeAt: string;
  expiresAt: string;
}

/** Fetch a challenge, spend the work, and return the minted code. Throws with the server's own
 *  message, which distinguishes "issuance is off" from "your work was rejected". */
export async function fetchPublishCode(onAttempt?: (tried: number) => void): Promise<PublishCode> {
  const cRes = await fetch("/api/publish-code/challenge");
  const cBody = (await cRes.json().catch(() => null)) as
    { challenge?: string; bits?: number; error?: string } | null;
  if (!cRes.ok || !cBody?.challenge || typeof cBody.bits !== "number") {
    throw new Error(cBody?.error || `could not get a challenge (${cRes.status})`);
  }

  const nonce = await solvePow(cBody.challenge, cBody.bits, onAttempt);

  const rRes = await fetch("/api/publish-code/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challenge: cBody.challenge, nonce }),
  });
  const rBody = (await rRes.json().catch(() => null)) as {
    code?: string; active_at?: string; expires_at?: string;
    active_immediately?: boolean; error?: string;
  } | null;
  if (!rRes.ok || !rBody?.code) {
    throw new Error(rBody?.error || `could not get a code (${rRes.status})`);
  }
  return {
    code: rBody.code,
    activeImmediately: rBody.active_immediately !== false,
    activeAt: rBody.active_at || "",
    expiresAt: rBody.expires_at || "",
  };
}
