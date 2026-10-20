import { DurableAgentDO } from "../src/do";
import { setDurableAgentRuntimeFactory } from "../src/injection";
import {
  createTestRuntime,
  readTestState,
  writeScript,
  type TestState,
  type TestScriptStep,
} from "./support";

setDurableAgentRuntimeFactory((_env, ctx) => createTestRuntime(ctx));

export class TestDurableAgentDO extends DurableAgentDO {
  script(steps: TestScriptStep[]): void {
    writeScript(this.ctx, steps);
  }

  state(): TestState {
    return readTestState(this.ctx);
  }

  /** Test seam for journal rows whose producers arrive with later tickets
   * (the ask channel's interaction flips, #591 T8's fold source). */
  journalRow(input: {
    id: string;
    type: string;
    data: Record<string, unknown>;
    createdAt: number;
  }) {
    return this.appendJournalRow(input);
  }

  /** #623 seam test: rebuild the runtime over the same storage. */
  async swapForTest(): Promise<void> {
    await this.swapRuntime(this.env, this.ctx);
  }
}

export default {
  fetch(): Response {
    return new Response("agent-durable test worker");
  },
};
