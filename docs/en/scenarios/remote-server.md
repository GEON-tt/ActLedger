[English](remote-server.md) | [简体中文](../../zh-CN/scenarios/remote-server.md)

# A remote server

## Where this fits

The agent machine has a URL and an agent key. It does not have the ledger, the signing private key, or the approver's password and authenticator secret. Those stay on the server. This is the deployment that can make "the agent cannot approve its own calls" true, provided the agent also cannot read the server's data volume or shell. The two local deployments only stop mistakes. See [Three deployments](../guarantees.md#three-deployments).

## Minimal code

```ts
import { Ledger } from "@actledger/sdk";

const ledger = new Ledger({ mode: "remote" });
```

`mode: "remote"` is required. `ACTLEDGER_URL` and `ACTLEDGER_API_KEY` fill in `url` and `apiKey` when you omit them. They do not switch a local ledger by themselves.

```python
from actledger import Ledger

ledger = Ledger(mode="remote")
```

Python uses the standard library (`urllib`). There is no separate async client. In async code, call `gate.async_before` / `gate.async_after` / `gate.async_resume`, or `await asyncio.to_thread(ledger.request, ...)`.

The agent id in code must match `agent-key create --agent`. If you send `agentId`, it must equal the key's agent, or the server returns `403 agent_mismatch`. `principalId` must be in the key's principal list, or the server returns `403 principal_not_allowed`. Omit `agentId` and the server uses the key's agent.

### Approve

Open the console, sign in with the username, password, and authenticator code. An approver only sees tasks for their own principal. A console approval is recorded as `channel: web` and `assurance: app_asserted`, with `stepUp: false`. A task that needs a higher assurance or a step-up cannot be approved there. The hint says so and points at `https://<host>/tasks/<id>`.

### Errors

| Situation | What the SDK raises |
| --- | --- |
| Network error or timeout, after retries | `LedgerUnavailable` (`ActLedger server unreachable: ...`) |
| `500`, or `502`/`503`/`504` after retries | `LedgerUnavailable` (`ActLedger server error <status>`). `500` is not retried |
| `401` | `LedgerError` `unauthorized`. This is not treated as unavailable |
| `GET /v1/tasks/:id` `404` | `getTask` / `get_task` returns null |
| Other JSON `4xx` | `LedgerError` with the server's `code`, `message`, `status`, and `details` |
| Non-JSON `4xx` (for example `421` plain text) | `LedgerError` `http_<status>` |

Writes retry at most twice, on network errors and `502`/`503`/`504`, only when the body has an `idempotencyKey`. `Ledger` and `TaskHandle` add one. Backoff is 200 ms then 600 ms.

### What is not available remotely

`setCoverageOverlay` raises `remote_unsupported`. Set coverage in the server policy. `sweep()` does nothing: the server sweeps itself every 5 seconds. Calling it must not fail, because wait and resume call it. The SDK has no approve, reject, reconcile, export, or key methods. Use the console and `actledger-server`. An agent key that calls approve, reject, or reconcile gets `403 forbidden`.

### Known limits

- Login rate limiting counts every attempt, including successes, before the password is checked: 20 attempts per IP per 15 minutes. People behind one NAT can block each other. Counting first is what stops a burst from skipping the limit.
- `GET /v1/export` returns the whole chain to any approver session. It is not filtered by principal. Receipts hold commitments, not plaintext payloads. Plaintext stays in the server secrets area and is not exported. One tenant per server; run another server when principals must be isolated.
- Locking an existing user returns `429` and `Retry-After` after 5 failures. An unknown username uses a different counter, so the responses can differ. Usernames are not a secret. The password and the authenticator code are still required.

## Policy

Set `min_assurance: app_asserted` on rules the console should approve. The default policy raises `send`, `spend`, and `delete` to `channel_verified` when a rule sets no minimum, and the console cannot record that.

## Next

[Deploy with Docker](../../../deploy/README.md). The guarantee table is in [guarantees](../guarantees.md#three-deployments). Field rules are in the [HTTP API](../../../spec/http.md).
