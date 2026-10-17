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

Which one to use:

- You own the agent loop, or the framework has no adapter: [ToolGate](tool-gate.md). Claude Agent SDK or OpenAI Agents SDK: the matching adapter ([integrations](integrations.md)). These are recorded.
- The tool is an MCP server you do not want the model to call directly: start it through the [MCP proxy](mcp-proxy.md). That is enforced for the tools the proxy exposes.
- Both can share one ledger directory. Step-by-step pages: [scenarios](scenarios/own-loop.md).

Two limits apply in both modes.

The hash chain shows that a recorded receipt was not altered. It does not show that every action was recorded. Coverage declarations say which action globs the application claims to have integrated, and at which mode. That declaration is written onto the receipt. ActLedger does not prove the declaration is complete.

`complete` reports the executed payload from the agent. That report is evidence strength `E1` (`evidence_assurance`). A stronger proof would be a third-party id or a third-party signature. Those are not required by the current verifier.

Local CLI approvals above `app_asserted`, and any step-up, are marked `approval.auth.simulated`. The CLI does not perform channel login or WebAuthn. A verifier can see that flag. It cannot turn the flag into a real identity check.

Web page and signed-link approvals are `app_asserted`. That value means this application claims the user confirmed. It does not represent a channel identity check.

`master.key` sits next to `ledger.db` in the local directory. That layout is for development. It is not a production key-management story.

High-risk levels in the policy vocabulary are `send`, `spend`, and `delete`. The loader warns with `uncovered_high_risk` when such an action has no coverage glob. The warning does not block the action.

See also [architecture.md](architecture.md) and the normative rules in [spec/verify.md](../../spec/verify.md).
