[English](guarantees.md) | [简体中文](../zh-CN/guarantees.md)

# Guarantee boundary

ActLedger is an SDK an agent application integrates on purpose. An action that never goes through ActLedger is outside the guarantee. For an action that does, the strength depends on where the check runs.

| | Recorded | Enforced |
| --- | --- | --- |
| Where the check runs | Inside the agent process | Outside it, between the agent and the tool |
| In this repository | ToolGate, `ledger.guard`, the Claude Agent SDK adapter, the OpenAI Agents SDK adapter | The MCP proxy, for the tools it exposes. A credential gate that releases a short-lived credential only after `executing` is not built yet |
| Who holds the real connection or credential | The agent | The proxy |
| What you get | Calls that go through the ledger follow the state machine, can be approved and verified, and later edits to their receipts are detectable | All of recorded mode, and that class of call cannot run until the ledger has claimed it |
| What you do not get | The model or the code can skip the wrapped tool, for example with a shell, a generic HTTP client, or a browser | Any path that does not go through the proxy. The operator has to keep network and credentials isolated |
| Coverage on the receipt | Whatever your `coverage` globs declare; an action with no matching glob is recorded | `mode: enforced`, `via: mcp-proxy`, added by the proxy for its exposed tools |

## Three deployments

| | In process (same system user) | Local console or CLI (same system user) | Remote server |
| --- | --- | --- | --- |
| Where the ledger and signing key are | On the agent machine, in `.actledger/` | Same | Only on the server |
| Can the agent approve its own call? | Yes. It can call the engine or `actledger approve` | Yes. It can read `serve.token` or run the CLI | No, if it cannot get the approver password and authenticator secret, and it has no server shell or data-volume access. An agent key that calls an approval route gets `403` |
| Can the agent edit the ledger and re-sign? | Yes. The private key is readable | Yes | No. The private key is not on the agent machine. A third party checks `/v1/keys` plus an export |
| Can the server operator edit the ledger? | — | — | Yes. Stopping that needs an external anchor (RFC 3161 and similar), which is on the roadmap |
| If the agent holds the real service credential | It can skip ActLedger | It can skip ActLedger | It can still skip ActLedger. The remote server approves and records. It does not execute on the agent's behalf. That needs a credential gate, which is on the roadmap |
| Fits | Development, and stopping mistakes | One person on one machine, stopping mistakes | A deployment that requires the agent not to approve itself |

The two local columns only stop mistakes. A separate system user plus the MCP proxy sits between them: the agent cannot read another user's `.actledger/`, and the operator has to keep that isolation. A remote approval is `app_asserted`. It is not a channel identity check. See [A remote server](scenarios/remote-server.md).

Which one to use:

- You own the agent loop, or the framework has no adapter: [ToolGate](tool-gate.md). Claude Agent SDK or OpenAI Agents SDK: the matching adapter ([integrations](integrations.md)). These are recorded.
- The tool is an MCP server you do not want the model to call directly: start it through the [MCP proxy](mcp-proxy.md). That is enforced for the tools the proxy exposes.
- Both can share one ledger directory. Step-by-step pages: [scenarios](scenarios/own-loop.md).

Two limits apply in both modes.

The hash chain shows that a recorded receipt was not altered. It does not show that every action was recorded. Coverage declarations say which action globs the application claims to have integrated, and at which mode. That declaration is written onto the receipt. ActLedger does not prove the declaration is complete.

`complete` reports the executed payload from the agent. That report is evidence strength `E1` (`evidence_assurance`). A stronger proof would be a third-party id or a third-party signature. Those are not required by the current verifier.

Local CLI approvals above `app_asserted`, and any step-up, are marked `approval.auth.simulated`. The CLI does not perform channel login or WebAuthn. A verifier can see that flag. It cannot turn the flag into a real identity check.

Web page and signed-link approvals are `app_asserted`. That value means this application claims the user confirmed. It does not represent a channel identity check.

`master.key` sits next to `ledger.db` in the local directory. That layout is for development. It is not a production key-management story. In a remote deployment the key file is only on the server.

High-risk levels in the policy vocabulary are `send`, `spend`, and `delete`. The loader warns with `uncovered_high_risk` when such an action has no coverage glob. The warning does not block the action.

See also [architecture.md](architecture.md) and the normative rules in [spec/verify.md](../../spec/verify.md).
