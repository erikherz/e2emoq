/**
 * No-op. Kept so the suites that call it keep running.
 *
 * In Wallflower this dismissed the seeds onboarding overlay, which sat over the whole page and
 * silently swallowed the first real click — a suite that clicked "Camera" and saw nothing
 * happen was hitting the overlay, not a broken control. There is no seed economy in e2eMoQ and
 * no overlay, so there is nothing to clear.
 *
 * A no-op rather than deleting the call sites: eight suites call this, the deletion is
 * mechanical, and a stub keeps the diff against Wallflower legible if a fix ever has to be
 * ported in either direction. If the seeds feature never comes back, inline the removal.
 */
export async function clearSeedGate(_page, note) {
  note?.("no seed gate in this build — nothing to clear");
}
