/**
 * Compile-isolation stub for the #29 lane's package (see agent-do-shim.d.ts
 * history): packages/agent-do is mid-flight and its in-progress sources must
 * not enter this package's typecheck program. Runtime resolution is
 * unaffected — wrangler/miniflare load the real package via the workspace
 * link; the RPC contract lives in src/seam/agent-do.ts. Drop this file (and
 * the tsconfig paths entry) at #29 closeout.
 */
export class AgentDO {}
