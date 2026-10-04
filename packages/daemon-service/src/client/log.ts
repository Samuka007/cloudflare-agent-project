/**
 * Client-side log line (plain stdout process). Kept in its own module so
 * the negotiation loop (and its tests) never transitively import the
 * executor's node:child_process graph.
 */
export function log(message: string): void {
  console.log(`[daemon-client] ${new Date().toISOString()} ${message}`);
}
