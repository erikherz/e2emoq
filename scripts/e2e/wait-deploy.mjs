// Poll until a deployed change is actually observable at the edge.
//
// `wrangler versions deploy` returns before the new Worker is live everywhere. Testing
// immediately reads the OLD code and produces a confident, wrong answer -- that has burned
// this project repeatedly. Poll for the behaviour instead of sleeping a guessed interval.
//
//   node scripts/e2e/wait-deploy.mjs <jsonPath> <expected> [origin]
//   e.g. node scripts/e2e/wait-deploy.mjs encrypted true

const [key, expectedRaw, origin = "https://e2emoq.com"] = process.argv.slice(2);
const expected = expectedRaw === "true" ? true : expectedRaw === "false" ? false : expectedRaw;

const DEADLINE = Date.now() + 180000;
let attempt = 0;

while (Date.now() < DEADLINE) {
  attempt++;
  const id = `p${Math.floor(Date.now() / 1000) % 100000}`.slice(0, 5);
  try {
    const r = await fetch(`${origin}/api/stats/broadcast`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream_id: id }),
    });
    const d = await r.json();
    if (d[key] === expected) {
      console.log(`propagated after ${attempt} probe(s): ${key}=${JSON.stringify(d[key])}`);
      process.exit(0);
    }
    console.log(`  probe ${attempt}: ${key}=${JSON.stringify(d[key])}, want ${JSON.stringify(expected)}`);
  } catch (e) {
    console.log(`  probe ${attempt}: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 5000));
}

console.error(`TIMEOUT: ${key} never became ${JSON.stringify(expected)}`);
process.exit(1);
