import { describe, expect, test } from "vitest";
import type { HostRpcRequestFrame, HostRpcResponseFrame } from "../src/protocol.js";
import { hostDirectoryListingSchema } from "../src/protocol.js";
import { SimulatedClient, serviceStub, uniqueHostId } from "./helpers.js";

/**
 * L1 host online RPC (#302): the control plane's one-shot daemon question —
 * the transport behind GET /hosts/:id/directory. bb anchors: the request/
 * response frames (host-daemon-contract session.ts:359-492), the hub waiter
 * semantics (hub.ts:634-687), and the void-on-session-death paths the bb
 * hub gets for free from socket lifetime (waiter keyed by requestId, stale
 * responses dropped).
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

function respondFailure(
  client: SimulatedClient,
  request: HostRpcRequestFrame,
  errorCode: string,
  errorMessage: string,
): void {
  client.send({
    type: "host-rpc.response",
    requestId: request.requestId,
    commandType: request.command.type,
    ok: false,
    errorCode,
    errorMessage,
  } satisfies HostRpcResponseFrame);
}

const LISTING = {
  directory: "/home/dev/proj",
  parent: "/home/dev",
  entries: [
    { kind: "directory", name: "src", path: "/home/dev/proj/src" },
    { kind: "file", name: "README.md", path: "/home/dev/proj/README.md" },
  ],
};

describe("L1 host online RPC (#302)", () => {
  test("request frame rides the live socket and the response resolves the caller", async () => {
    const hostId = uniqueHostId("dirrpc");
    const client = new SimulatedClient(hostId);
    await client.dial();

    const rpc = serviceStub(hostId).hostOnlineRpc({
      hostId,
      command: { type: "host.browse_directory" },
      timeoutMs: 5_000,
    });
    const request = await waitForHostRpcRequest(client);
    // No `path` key when omitted — the daemon resolves the home directory.
    expect(request.command).toEqual({ type: "host.browse_directory" });
    respondOk(client, request, LISTING);
    await expect(rpc).resolves.toEqual({
      kind: "ok",
      response: {
        type: "host-rpc.response",
        requestId: request.requestId,
        commandType: "host.browse_directory",
        ok: true,
        result: LISTING,
      },
    });
    await client.close();
  });

  test("an explicit path rides through verbatim", async () => {
    const hostId = uniqueHostId("dirrpc");
    const client = new SimulatedClient(hostId);
    await client.dial();

    const rpc = serviceStub(hostId).hostOnlineRpc({
      hostId,
      command: { type: "host.browse_directory", path: "/home/dev" },
      timeoutMs: 5_000,
    });
    const request = await waitForHostRpcRequest(client);
    expect(request.command).toEqual({ type: "host.browse_directory", path: "/home/dev" });
    respondOk(client, request, LISTING);
    await rpc;
    await client.close();
  });

  test("a daemon dispatch failure surfaces verbatim (errorCode + errorMessage)", async () => {
    const hostId = uniqueHostId("dirrpc");
    const client = new SimulatedClient(hostId);
    await client.dial();

    const rpc = serviceStub(hostId).hostOnlineRpc({
      hostId,
      command: { type: "host.browse_directory", path: "/etc/hostname" },
      timeoutMs: 5_000,
    });
    const request = await waitForHostRpcRequest(client);
    respondFailure(client, request, "invalid_path", 'Path "/etc/hostname" is not a directory');
    await expect(rpc).resolves.toEqual({
      kind: "ok",
      response: {
        type: "host-rpc.response",
        requestId: request.requestId,
        commandType: "host.browse_directory",
        ok: false,
        errorCode: "invalid_path",
        errorMessage: 'Path "/etc/hostname" is not a directory',
      },
    });
    await client.close();
  });

  test("an unanswered request times out on its own timer", async () => {
    const hostId = uniqueHostId("dirrpc");
    const client = new SimulatedClient(hostId);
    await client.dial();

    const outcome = await serviceStub(hostId).hostOnlineRpc({
      hostId,
      command: { type: "host.browse_directory" },
      timeoutMs: 300,
    });
    expect(outcome).toEqual({ kind: "timeout" });
    // The late response after the timeout is a stale drop, not a crash.
    const request = await waitForHostRpcRequest(client);
    respondOk(client, request, LISTING);
    await client.close();
  });

  test("no live session answers host_offline — misrouted hostIds included", async () => {
    const hostId = uniqueHostId("dirrpc");
    const stub = serviceStub(hostId);
    await expect(
      stub.hostOnlineRpc({
        hostId,
        command: { type: "host.browse_directory" },
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ kind: "host_offline" });

    // A dialed client for ANOTHER host id is offline for this one (the DO
    // name is the machine identity; the session must match the asked host).
    const other = new SimulatedClient(uniqueHostId("dirrpc"));
    await other.dial();
    await expect(
      stub.hostOnlineRpc({
        hostId,
        command: { type: "host.browse_directory" },
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ kind: "host_offline" });
    await other.close();
  });

  test("a session replace voids the in-flight waiter with host_offline", async () => {
    const hostId = uniqueHostId("dirrpc");
    const first = new SimulatedClient(hostId);
    await first.dial();

    const rpc = serviceStub(hostId).hostOnlineRpc({
      hostId,
      command: { type: "host.browse_directory" },
      timeoutMs: 10_000,
    });
    await waitForHostRpcRequest(first);

    // 顶替 (§5.2.5): the second dial replaces the session; the first
    // session's in-flight request dies with it — host_offline, not a hang.
    const second = new SimulatedClient(hostId);
    await second.dial();
    await expect(rpc).resolves.toEqual({ kind: "host_offline" });

    // The live session still answers: the seam works after a replace.
    const rpc2 = serviceStub(hostId).hostOnlineRpc({
      hostId,
      command: { type: "host.browse_directory" },
      timeoutMs: 5_000,
    });
    const request2 = await waitForHostRpcRequest(second);
    respondOk(second, request2, LISTING);
    await expect(rpc2).resolves.toMatchObject({ kind: "ok" });
    await first.close();
    await second.close();
  });

  test("the DO relays any well-formed listing; shape is the route's parse job", () => {
    // The wire face is deliberately result-opaque (bb parses server-side);
    // pin the listing schema the server route validates against.
    expect(hostDirectoryListingSchema.parse(LISTING)).toEqual(LISTING);
  });
});
