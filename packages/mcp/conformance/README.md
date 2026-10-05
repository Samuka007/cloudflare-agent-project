# @cap/mcp client conformance (#327)

Runs the official [MCP conformance suite](https://github.com/modelcontextprotocol/conformance)
against the vendored @cap/mcp client (`client.ts`) and compares the result with
a committed baseline.

```bash
pnpm --filter @cap/mcp run test:conformance
```

CI runs it as the `mcp-conformance` step of `.github/workflows/ci.yml`
(after the Bun setup, like the daemon runtime suite). Requires network access
the first time, to fetch the pinned suite
(`@modelcontextprotocol/conformance@0.2.0-alpha.11`) with `npx`. Install
scripts are disabled. Needs a POSIX shell.

## How it works

For every protocol version the client negotiates (`2025-03-26`, `2025-06-18`,
`2025-11-25`), `run.ts` lists the suite's client scenarios and runs them one
at a time. The suite starts a scenario server and runs `client.ts` against it.

`client.ts` uses the vendored package's own exports — `McpClient` over
`StreamableHttpTransport` with `McpOAuthProvider` credentials — which is the
same stack the edge integration (@cap/agent-do `tools/mcp.ts`) runs in
production. A simulated browser fetches the authorization URL and delivers
the redirect to the package's loopback `OAuthCallbackServer`. When the server
asks for sign-in again (for example for more scope), the simulated user signs
in again, up to three times.

Every check the suite reports is compared with `baseline.json`. The extra
`cap-client` check records whether `client.ts` completed the scenario. Some
scenarios expect the client to give up (`auth/scope-retry-limit`), so it is
baselined like the others.

The run fails when:

- a check that passes in the baseline fails or is missing,
- a check fails that the baseline does not list as failing,
- a baselined scenario did not run.

Checks that started passing are reported; update the baseline to lock them in.

## Options

```bash
bun packages/mcp/conformance/run.ts --mode 2025-11-25 --scenario auth/scope-step-up --verbose
bun packages/mcp/conformance/run.ts --update-baseline
```

- `--mode`, `--scenario`: run a subset (repeatable).
- `--verbose`: print the suite's output, including each check and the client's log.
- `--keep-results`: keep the suite's `checks.json` and client output.
- `--update-baseline`: write the results of a full run to `baseline.json`. Review the diff; do not regenerate it to hide a regression.

## Known failures (mirroring upstream pi)

- `elicitation-sep1034-client-defaults`: the client does not support elicitation.
- `auth/basic-cimd`: the client registers dynamically instead of using a Client ID Metadata Document.
- `auth/scope-retry-limit`: `cap-client` fails by design; the server never accepts the granted scope.

2026-07-28 is not covered: it is a stateless protocol the client does not speak.

## Provenance

Runner and client are ported from upstream
`packages/coding-agent/test/mcp-conformance/` (pi @ `98d2e1947aa9`); the
pi-side `McpServerConnection`/`signInMcpServer` orchestration is re-expressed
over the package's own OAuth exports, so the suite gates the vendored package
itself.
