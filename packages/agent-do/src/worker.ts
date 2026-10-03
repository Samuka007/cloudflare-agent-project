import { AgentDO } from "./agent-do.js";
import { TestDaemonServiceDO } from "./testing/test-daemon-do.js";

/** Wrangler main: the DO class must be exported from the deployed entry. */
export { AgentDO, TestDaemonServiceDO };

export default {
  fetch(): Response {
    return new Response("agent-do: DO-only worker (bind AGENT_DO)", { status: 404 });
  },
} satisfies ExportedHandler;
