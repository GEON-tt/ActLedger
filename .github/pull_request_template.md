## Summary (变更说明)

## Related issue (关联 issue)

## Checklist (清单)

- [ ] Commits are signed off with the DCO (`git commit -s`)（commit 已 DCO 签名）
- [ ] `pnpm test` and `pnpm typecheck` pass（`pnpm test` 和 `pnpm typecheck` 通过）
- [ ] A changeset is included when a published package changes（影响发布包时已加 changeset）
- [ ] Protocol changes update `spec/*.md`, `spec/zh-CN/*.md`, schemas, and test-vectors（影响协议时已同步 spec、schema 和 test-vectors）
- [ ] This PR touches canonicalization, commitments, signatures, verification, or the state machine: yes / no. If yes, it needs a review from someone other than the maintainer, or it is marked maintainer-only（本 PR 涉及规范化、承诺、签名、校验或状态机：是 / 否。如果是，需要非维护者 review，或标注「仅维护者审阅」）
- [ ] No `.env`, keys, `.actledger/`, or `*.db` are committed（没有提交 `.env`、密钥、`.actledger/` 或 `*.db`）
