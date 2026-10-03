import { describe, expect, it } from "vitest";
import { orchestratorFor, type OrchestratorStub } from "../helpers.js";

/**
 * ensureHost (#31 composition seam): the command journal binds a host
 * identity without opening a daemon session, so provider-route commands are
 * journalable before any daemon client enrolls. First writer wins (the same
 * pinning rule as openSession), and the binding is idempotent.
 */

const orchestrator = (): OrchestratorStub => orchestratorFor();

describe("ensureHost (journal host binding without a session)", () => {
  it("binds the host and stays idempotent across re-binds", async () => {
    const orch = orchestrator();
    expect(await orch.ensureHost({ hostId: "local" })).toEqual({ kind: "bound", hostId: "local" });
    expect(await orch.ensureHost({ hostId: "local" })).toEqual({ kind: "bound", hostId: "local" });

    // enqueueCommand previously threw "no host bound" — it must now work.
    const { commandId } = await orch.enqueueCommand({
      type: "initialize",
      command: { type: "initialize" },
      threadId: "thr_host",
    });
    expect(commandId).toBeTruthy();
  });

  it("keeps the first-pinned hostId when a different host asks", async () => {
    const orch = orchestrator();
    await orch.ensureHost({ hostId: "local" });
    expect(await orch.ensureHost({ hostId: "other" })).toEqual({
      kind: "host_mismatch",
      boundHostId: "local",
    });
  });
});
