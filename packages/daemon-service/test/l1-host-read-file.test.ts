import { describe, expect, test } from "vitest";
import type { HostRpcRequestFrame, HostRpcResponseFrame } from "../src/protocol.js";
import { hostFileReadResultSchema } from "../src/protocol.js";
import { SimulatedClient, serviceStub, uniqueHostId } from "./helpers.js";

/**
 * L1 host read-file RPC (B1 #321): the transport behind
 * GET /threads/:id/host-files/content — `host.read_file` joins the #302
 * host-rpc command union, so the DO waiter / stale-response / session-replace
 * semantics are the l1-host-directory ones by construction. These pins cover
 * what is new: the command rides the live socket verbatim and the file result
 * shape parses at the protocol gate (the daemon handler semantics live in the
 * bun suite, host-files.test.ts).
 */

function waitForHostRpcRequest(client: SimulatedClient): Promise<HostRpcRequestFrame> {
  return client.waitFor(
    (candidate): candidate is HostRpcRequestFrame => candidate.type === "host-rpc.request",
  );
}

function respondOk(client: SimulatedClient, request: HostRpcRequestFrame, result: unknown): void {
  const response: HostRpcResponseFrame = {
    type: "host-rpc.response",
    requestId: request.requestId,
    commandType: request.command.type,
    ok: true,
    result,
  };
  client.send(response);
}

const FILE_RESULT = {
  path: "/tmp/rendered.png",
  content: btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47)),
  contentEncoding: "base64",
  mimeType: "image/png",
  sizeBytes: 4,
  modifiedAtMs: 1_000,
  sha256: "a".repeat(64),
};

describe("L1 host read-file RPC (#321)", () => {
  test("the command rides the live socket verbatim and the result resolves the caller", async () => {
    const hostId = uniqueHostId("filerpc");
    const client = new SimulatedClient(hostId);
    await client.dial();

    const rpc = serviceStub(hostId).hostOnlineRpc({
      hostId,
      command: { type: "host.read_file", path: "/tmp/rendered.png" },
      timeoutMs: 5_000,
    });
    const request = await waitForHostRpcRequest(client);
    expect(request.command).toEqual({ type: "host.read_file", path: "/tmp/rendered.png" });
    respondOk(client, request, FILE_RESULT);
    await expect(rpc).resolves.toEqual({
      kind: "ok",
      response: {
        type: "host-rpc.response",
        requestId: request.requestId,
        commandType: "host.read_file",
        ok: true,
        result: FILE_RESULT,
      },
    });
    await client.close();
  });

  test("the daemon-side result parses at the protocol gate (hostFileReadResultSchema)", () => {
    expect(hostFileReadResultSchema.parse(FILE_RESULT)).toEqual(FILE_RESULT);
    expect(
      hostFileReadResultSchema.safeParse({ ...FILE_RESULT, contentEncoding: "hex" }).success,
    ).toBe(false);
    expect(hostFileReadResultSchema.safeParse({ ...FILE_RESULT, sha256: undefined }).success).toBe(
      false,
    );
    expect(hostFileReadResultSchema.safeParse({ ...FILE_RESULT, mimeType: undefined }).success).toBe(
      true,
    );
  });
});
