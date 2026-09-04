/**
 * Which view the app resolved to, published once and awaitable by anything that needs it.
 *
 * This exists because the URL cannot be trusted to answer the question. `getRouteInfo()`
 * REWRITES the address for /broadcast — it mints a stream id and replaces the path with
 * `/?stream=<id>` — so code that sniffs `location.pathname` gets a different answer depending
 * on whether it happened to run before or after that. Re-deriving the route in a second place
 * would also be a copy that drifts from the original the first time the rules change.
 *
 * A module of its own rather than an export from main.ts, so importers do not form a cycle
 * with it.
 *
 * Resolved EARLY in init(), immediately after the route is decided and before the slow work
 * (fetching the user, connecting to a stream), so a consumer waiting on it waits milliseconds
 * rather than for the page to finish coming up.
 */
export type AppView = "landing" | "broadcast" | "watch";

let publish!: (v: AppView) => void;

/** Awaited by consumers. Never rejects: if init() dies before deciding, this simply stays
 *  pending, which leaves the waiter doing nothing rather than doing the wrong thing. */
export const viewKnown: Promise<AppView> = new Promise<AppView>((resolve) => {
  publish = resolve;
});

/** Called once, by init(). Later calls are ignored — a Promise keeps its first settlement. */
export function publishView(view: AppView): void {
  publish(view);
}
