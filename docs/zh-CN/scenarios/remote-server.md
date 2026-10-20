[English](../../en/scenarios/remote-server.md) | [简体中文](remote-server.md)

# 远端服务器

## 放在哪里

agent 机器上只有 URL 和 agent key。没有账本、签名私钥，也没有审批人的密码和验证器密钥。这些都在服务器上。在 agent 也读不到服务器数据卷或 shell 的前提下，这是能让「agent 不能批准自己的调用」成立的部署。本地两种部署只防误操作。见[三种部署](../guarantees.md#三种部署)。

## 最小代码

```ts
import { Ledger } from "@actledger/sdk";

const ledger = new Ledger({ mode: "remote" });
```

必须显式写 `mode: "remote"`。省略 `url` 和 `apiKey` 时，用 `ACTLEDGER_URL` 和 `ACTLEDGER_API_KEY` 补上。环境变量本身不会把一个本地账本切走。

```python
from actledger import Ledger

ledger = Ledger(mode="remote")
```

Python 用标准库 `urllib`。没有单独的异步客户端。异步代码里调用 `gate.async_before` / `gate.async_after` / `gate.async_resume`，或 `await asyncio.to_thread(ledger.request, ...)`。

代码里的 agent id 必须和 `agent-key create --agent` 一致。如果传了 `agentId`，它必须等于这把 key 绑定的 agent，否则服务器返回 `403 agent_mismatch`。`principalId` 必须在 key 的 principal 列表里，否则返回 `403 principal_not_allowed`。不传 `agentId` 时，服务器用 key 上的 agent。

### 批准

打开审批台，用用户名、密码和验证器码登录。审批人只看得到自己 principal 的任务。审批台记下的批准是 `channel: web`、`assurance: app_asserted`、`stepUp: false`。需要更高保证或 step-up 的任务在这里批不了。提示会说明这一点，并指向 `https://<host>/tasks/<id>`。

### 错误

| 情况 | SDK 抛出 |
| --- | --- |
| 网络错误或超时，重试之后 | `LedgerUnavailable`（`ActLedger server unreachable: ...`） |
| `500`，或重试之后的 `502`/`503`/`504` | `LedgerUnavailable`（`ActLedger server error <status>`）。`500` 不重试 |
| `401` | `LedgerError` `unauthorized`。这不算不可用 |
| `GET /v1/tasks/:id` 返回 `404` | `getTask` / `get_task` 返回 null |
| 其他带 JSON 的 `4xx` | `LedgerError`，保留服务器的 `code`、`message`、`status`、`details` |
| 非 JSON 的 `4xx`（例如 `421` 纯文本） | `LedgerError` `http_<status>` |

写请求最多再试 2 次，只在网络错误和 `502`/`503`/`504` 上重试，而且 body 里要有 `idempotencyKey`。`Ledger` 和 `TaskHandle` 会自己加上。退避是 200 ms，然后 600 ms。

### 远端没有的操作

`setCoverageOverlay` 抛出 `remote_unsupported`。覆盖率写在服务器策略里。`sweep()` 什么都不做：服务器每 5 秒自己 sweep。这里不能抛错，因为 wait 和 resume 都会调用它。SDK 没有 approve、reject、reconcile、export 或 key 方法。用审批台和 `actledger-server`。agent key 调用 approve、reject 或 reconcile 得到 `403 forbidden`。

### 已知取舍

- 登录限流在校验密码之前就把每一次尝试算进去，成功也算：同一 IP 15 分钟 20 次。共用一个 NAT 出口的人可能互相挡住。先计数是为了不让并发请求绕过限额。
- `GET /v1/export` 把整条链给任意已登录的审批人，不按 principal 过滤。回执里是承诺，不是明文载荷。明文在服务器的 secrets 区，不导出。一个服务器一个租户；principal 必须隔开时再跑一个服务器。
- 已存在的用户失败 5 次后返回 `429` 和 `Retry-After`。未知用户名用另一套计数，两种响应可能不一样。用户名不是秘密。门槛仍然是密码加验证器码。

## 策略

审批台要能批的规则写成 `min_assurance: app_asserted`。默认策略里，规则没有写最低保证时，`send`、`spend`、`delete` 会抬到 `channel_verified`，审批台记录不了。

## 接下来

[用 Docker 部署](../../../deploy/README.zh-CN.md)。保证对照表在[保证边界](../guarantees.md#三种部署)。字段规则在 [HTTP API](../../../spec/zh-CN/http.md)。
