import { describe, expect, it } from "vitest";
import { resolveSendMode } from "../../src/routes/threads.js";
import { ApiError } from "../../src/shared/api-error.js";

/**
 * bb resolveSendMode (services/threads/thread-send.ts:175-216) mapping,
 * pinned here so the port's send-mode discrimination stays in lockstep.
 */
describe("resolveSendMode (bb thread-send.ts:175-216)", () => {
  it("start on active thread throws already_active", () => {
    expect(() => resolveSendMode("active", "start")).toThrow(ApiError);
    try {
      resolveSendMode("active", "start");
    } catch (error) {
      expect((error as ApiError).status).toBe(409);
      expect((error as ApiError).code).toBe("thread_not_writable");
    }
  });

  it("start on any non-active status starts", () => {
    for (const status of ["idle", "starting", "stopping", "error"]) {
      expect(resolveSendMode(status, "start")).toBe("start");
    }
  });

  it("steer into active, start when idle/error, refuse transitional", () => {
    expect(resolveSendMode("active", "steer")).toBe("steer");
    expect(resolveSendMode("active", "steer-if-active")).toBe("steer");
    expect(resolveSendMode("idle", "steer")).toBe("start");
    expect(resolveSendMode("error", "steer")).toBe("start");
    expect(() => resolveSendMode("starting", "steer")).toThrow(ApiError);
    expect(() => resolveSendMode("stopping", "steer-if-active")).toThrow(ApiError);
  });

  it("auto steers into active and starts otherwise", () => {
    expect(resolveSendMode("active", "auto")).toBe("auto");
    expect(resolveSendMode("idle", "auto")).toBe("start");
    expect(resolveSendMode("starting", "auto")).toBe("start");
  });

  it("queue-if-active falls through to start when idle (M0 queue family OUT)", () => {
    expect(resolveSendMode("idle", "queue-if-active")).toBe("start");
    expect(() => resolveSendMode("active", "queue-if-active")).toThrow(ApiError);
  });
});
