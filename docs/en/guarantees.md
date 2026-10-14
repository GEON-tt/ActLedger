[English](guarantees.md) | [简体中文](../zh-CN/guarantees.md)

# Guarantee boundary

ActLedger is an SDK an agent application integrates on purpose. An action that never goes through ActLedger is outside the guarantee. For an action that does, the strength depends on how it was integrated.

| Mode | How | What you get | What you do not get |
| --- | --- | --- | --- |
| `recorded` | SDK or an adapter wraps the tool. The real credential stays in the agent | Calls that go through the ledger follow the state machine. They can be approved and verified. Later edits to those receipts are detectable | The model or the code can skip the wrapped tool, for example with a shell, a generic HTTP client, or a browser |
| `enforced` | The agent has no path around the ledger. Today that means the MCP proxy. A credential gate that releases a short-lived credential only after `executing` is not built yet | On top of recorded mode, that class of call cannot run until the ledger has claimed it | Any path that does not go through the proxy. The operator has to keep network and credentials isolated |

Two limits apply in both modes.

The hash chain shows that a recorded receipt was not altered. It does not show that every action was recorded. Coverage declarations say which action globs the application claims to have integrated, and at which mode. That declaration is written onto the receipt. ActLedger does not prove the declaration is complete.

`complete` reports the executed payload from the agent. That report is evidence strength `E1` (`evidence_assurance`). A stronger proof would be a third-party id or a third-party signature. Those are not required by the current verifier.

Local CLI approvals above `app_asserted`, and any step-up, are marked `approval.auth.simulated`. The CLI does not perform channel login or WebAuthn. A verifier can see that flag. It cannot turn the flag into a real identity check.

Web page and signed-link approvals are `app_asserted`. That value means this application claims the user confirmed. It does not represent a channel identity check.

`master.key` sits next to `ledger.db` in the local directory. That layout is for development. It is not a production key-management story.

High-risk levels in the policy vocabulary are `send`, `spend`, and `delete`. The loader warns with `uncovered_high_risk` when such an action has no coverage glob. The warning does not block the action.

See also [architecture.md](architecture.md) and the normative rules in [spec/verify.md](../../spec/verify.md).
