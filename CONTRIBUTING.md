[English](CONTRIBUTING.md) | [简体中文](CONTRIBUTING.zh-CN.md)

# Contributing

## Development setup

Node.js 22.13 or newer, and pnpm 9. Enable Corepack, then install:

```bash
corepack enable
pnpm install
```

Python tests need Python 3.10 or newer:

```bash
python3 -m venv python/.venv
python/.venv/bin/pip install -e "./python[dev]"
python/.venv/bin/pytest python -q
```

## Common commands

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm pack:check
pnpm actledger ...
```

`pnpm test` and `pnpm typecheck` run the TypeScript source. They do not need `pnpm build` first. `pnpm pack:check` builds, packs, and installs the tarballs from the network. It is not part of `pnpm test`.

## DCO

Every commit must include `Signed-off-by: Name <email>`. Generate it with `git commit -s`.

The signature means you have the right to submit the code under Apache-2.0. This repository does not use a CLA.

If a commit that has not been pushed is missing the trailer, add it with `git commit --amend -s`. For several commits, use `git rebase --signoff`.

The Developer Certificate of Origin 1.1 is reproduced below. See also <https://developercertificate.org/>.

```text
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

## Changesets

A pull request that changes a published package (`@actledger/core`, `@actledger/sdk`, `@actledger/cli`, `@actledger/mcp-proxy`) needs `pnpm changeset`. Documentation-only or example-only changes can omit it. See [`.changeset/README.md`](.changeset/README.md).

## Specification changes

A pull request that changes `spec/`, receipt fields, hash or signature inputs, or state transitions must update the schemas, both `spec/*.md` and `spec/zh-CN/*.md`, and `spec/test-vectors/`. Regenerate vectors with `pnpm vectors` and commit them. The keys in the vectors are random, so signatures change after regeneration.

Changes to the external format go through an RFC: open a pull request under `spec/rfcs/` and leave it open for discussion for at least 7 days.

Before v1.0, a minor version may be incompatible. `verify` must keep validating every previously published version. After v1.0, only optional fields may be added. Changing the hash or signature input requires a major version.

## Review of security-sensitive changes

Changes to canonicalization, commitments, signatures, verification, or the state machine need a review from someone other than a maintainer. If that is not possible in the first year, mark the pull request "maintainer review only".

## Style

Follow the surrounding code. TypeScript is strict. Relative imports under `packages/*/src` must use the `.js` suffix. New behavior needs tests.

## Plugins

Plugins can live in their own repositories and be maintained by their authors. Ask to be listed under Community plugins in the README with a pull request.

## Security

Do not open a public issue. See [SECURITY.md](SECURITY.md).
