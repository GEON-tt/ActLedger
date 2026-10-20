[English](SECURITY.md) | [简体中文](SECURITY.zh-CN.md)

# Security policy

## Supported versions

Only the latest 0.1.x is fixed. There are no backports before v1.0.

## Private reports

Do not open a public issue, and do not post exploit details in discussions.

- Preferred: [GitHub Private vulnerability reporting](https://github.com/GEON-tt/ActLedger/security/advisories/new) (Report a vulnerability on the repository Security page).
- Backup email: `zh1751259510@gmail.com`.

## Response targets

- Acknowledge within 3 business days.
- Initial assessment within 7 days.
- Aim to fix and coordinate disclosure within 90 days. Details stay private until the fix is released.

## In scope

The following are vulnerabilities:

- Forged receipts, or a bypass of the hash chain or signatures
- Ambiguous JCS canonicalization
- A commitment that can be reversed to plaintext
- A state machine that can be skipped (for example a repeated claim, or a replay of `executing`)
- Policy evaluation that grants more than the rules allow
- An MCP proxy bypass that is still reported as `enforced`
- A path that leaks the `secrets` file or `master.key`
- An agent key that can approve, reject, reconcile, or export, or that can act for a principal it was not given
- A bypass of TOTP or of an approver session
- A CSRF or `Origin` bypass on the remote approval console
- Vulnerabilities in dependencies

## Out of scope

The following are the stated guarantee boundary. The hash chain proves that what was recorded was not changed. It does not prove that everything was recorded.

- Under recorded integration, the model bypasses a wrapped tool
- Actions that were never integrated
- A local CLI approval marked `simulated`
- `master.key` stored next to the database (development only)
- A local agent, running as the same system user, approving its own call by reading `serve.token` or by running the CLI
- The operator of the server changing the ledger. Detecting that needs an external anchor
- An agent that already holds the real service credential and calls the service without ActLedger. Stopping that needs a credential gate
- Login rate limiting counts successful attempts. Twenty tries from one IP in 15 minutes, including successes, can block other people behind the same NAT. Counting before the password check is what stops a concurrent burst from skipping the limit
- `GET /v1/export` on an approver session returns the whole chain, not one principal. Receipts hold commitments. Plaintext stays in the server secrets area and is not exported. Isolate principals with separate servers
- After five failures an existing username returns `429` with `Retry-After`, and an unknown username uses a different counter, so the responses can reveal whether the username exists. Usernames are not a secret. The password and authenticator code remain the barrier

## Credit

Reporters can be credited in the release notes if they want to be.
