/// <reference types="@cloudflare/vitest-plugin/types" />

declare namespace Cloudflare {
  interface Env {
    AGENT_DO: DurableObjectNamespace<import("./worker").TestDurableAgentDO>;
  }
}
