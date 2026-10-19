import { DurableAgentDO } from "../src/do.js";
import { setDurableAgentRuntimeFactory } from "../src/injection.js";
import {
  createTestRuntime,
  readTestState,
  writeScript,
  type TestState,
  type TestScriptStep,
} from "./support.js";

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
