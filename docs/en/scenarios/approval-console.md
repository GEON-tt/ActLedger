[English](approval-console.md) | [简体中文](../../zh-CN/scenarios/approval-console.md)

# The approval console

## Where this fits

`actledger serve` does not make a recorded integration enforced ([guarantees](../guarantees.md)). It is a local page on `127.0.0.1` where a person approves or rejects tasks from any integration above. It sits outside the agent process, so the agent cannot approve its own calls. Approvals made here are `app_asserted`: the application claims the user confirmed, not a channel identity check.

## Minimal code

Taken from [`packages/cli/src/main.ts`](../../../packages/cli/src/main.ts).

```bash
pnpm actledger init
pnpm actledger serve --dir .actledger
# actledger serve http://127.0.0.1:4319
# login: http://127.0.0.1:4319/login?token=…
```

### Log in again

The same URL works after a restart and for more than one login. Each login opens a new session. The token file is `.actledger/serve.token`, mode 0600.

This prints the URL and does not start the server:

```bash
pnpm -s actledger serve --print-login --dir .actledger
```

The URL's port comes from `--port` (default 4319), so pass the same `--port` when the server is on another port. `-s` keeps pnpm from printing its own banner, and the line can be opened with `open "$(…)"`.

The demo's console:

```bash
pnpm -s actledger serve --print-login --dir examples/chat-approval/out/ledger --port 4328
```

If the session has ended when the list refreshes, the page says `Session ended. Run actledger serve --print-login and open the URL again.`

A session expires after 12 idle hours, or 24 hours from creation. Log out ends only the current session. The URL still works.

### Rotate the token

```bash
pnpm actledger serve --rotate-token --dir .actledger                 # rotate, then start
pnpm -s actledger serve --print-login --rotate-token --dir .actledger # rotate and print, no server
```

After a rotation, the old URL and every existing session stop working. A serve process that is already running rejects the old token on its next request. `--one-time-login` keeps an in-memory token that works once and is never written to a file. It cannot be combined with `--token-file`, `--rotate-token`, or `--print-login`. `--print-login` cannot be combined with `--approver`.

### What the page shows

Three tabs: Pending approvals, Recent decisions, and All tasks. The page refreshes them every 3 seconds from `GET /api/tasks`. With JavaScript off, the tab links still switch the list.

The task page has a `You are approving` block (action, args, and `presented_hash`), a Decision block, and a Timeline. The timeline labels are requested, pending approval, approved by policy, approved, denied by policy, rejected, claimed, completed, failed, unknown, expired, revoked, and drafted.

A rejection needs a reason of at most 2000 characters. The CLI form is `actledger reject <task> --note <reason>`.

### Assurance levels

| Level | Where it comes from |
| --- | --- |
| `policy` | An `allow` rule approved it; approver `policy:<rule id>` |
| `app_asserted` | The console, a signed webhook link, or `actledger approve` without `--assurance` |
| `channel_verified` | Only `actledger approve --assurance channel_verified` in this release, marked `simulated` |
| `user_signed` | Only `actledger approve --assurance user_signed`, marked `simulated` |

### Why Approve is disabled

When the task's minimum assurance is above `app_asserted`, the page can only record `app_asserted`, and the engine would answer `assurance_insufficient`, so the button is disabled. The page says: `Approve is disabled: this action needs <min> assurance, and this page can only record app_asserted. Approve it with the CLI (actledger approve <id> --assurance <min>) or a verified channel. You can still reject it here with a reason.`

The minimum comes from the rule's `approval.min_assurance`. When the action level is `send`, `spend`, or `delete` and the rule sets none, it is raised to `channel_verified` ([evaluate.ts](../../../packages/core/src/policy/evaluate.ts)). The default policy's `email.send` rule explicitly requires `channel_verified`.

What you can do: reject it here with a reason (a rejection does not check assurance); approve with `actledger approve <id> --assurance channel_verified` (the receipt is marked simulated; see [guarantees](../guarantees.md)); or write `min_assurance: app_asserted` on the rule on purpose.

Other reasons the buttons are disabled: the task needs a step-up, which only the CLI `--step-up` flag can supply, and that approval is also simulated; the task's channels do not include `web`, which disables both Approve and Reject; `--approver` is not the task principal, which also disables both.

## Policy

`actledger init` writes the default policy to `.actledger/policy.yaml` ([source](../../../packages/core/src/default-policy.ts)). With that file unchanged, a gated tool call is `tool.<name>`, which is not listed under `actions`, so no rule matches and `defaults.unknown_action: require_approval` applies: the task waits for approval (rule id `default:require_approval`), at assurance `app_asserted`, approvable from `cli` or `web`. Edit that file instead of writing a new one. A policy file is used as a whole; keys you leave out of `defaults` fall back to engine values, and the fallback for `approval.channels` is an empty list, which means CLI only.

For this page, `approval.channels` has to include `web`. The default file already does. A file you write that omits `channels` is CLI only. Add `webhook_link` when you want a signed link. When `allow_edit` is true, editing is only available as `actledger approve <id> --edit`. The channel list is fixed when the task is created. Editing the policy later changes only new tasks.

## Next

- [Approval](../approval.md) covers the cookie, Origin checks, webhooks, and the full signed-link rules.
- [Guarantees](../guarantees.md)
- [examples/chat-approval](../../../examples/chat-approval/README.md)
