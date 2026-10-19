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
}

export default {
  fetch(): Response {
    return new Response("agent-durable test worker");
  },
};
