import fs from "node:fs";
import { jcs, LedgerError, openLedger, type Payload, type UserAssurance } from "@actledger/core";

function readEdit(file: string | undefined): Payload | null {
  if (!file) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as Payload;
}

export function approveCommand(opts: {
  dir: string;
  id: string;
  assurance: UserAssurance;
  edit?: string;
  stepUp: boolean;
  json: boolean;
}): void {
  const engine = openLedger({ dir: opts.dir });
  try {
    const task = engine.getTask(opts.id);
    if (!task) throw new LedgerError("not_found", `task ${opts.id} not found`, 404);
    const payload = engine.taskPayload(opts.id);
    const intent = engine.taskIntent(opts.id);
    process.stderr.write(
      [`action: ${task.action.type}`, `intent: ${intent ?? ""}`, `payload_hash: ${task.payloadHash}`, jcs(payload), ""].join(
        "\n",
      ),
    );
    const result = engine.approve(opts.id, {
      approverPrincipalId: task.principalId,
      channel: "cli",
      assurance: opts.assurance,
      presentedHash: task.payloadHash,
      editedPayload: readEdit(opts.edit),
      stepUp: opts.stepUp,
      simulated: opts.stepUp || opts.assurance !== "app_asserted",
    });
    if (opts.json) process.stdout.write(`${JSON.stringify(result.task, null, 2)}\n`);
    else process.stdout.write(`${result.task.id} ${result.task.state} ${result.receipt.hash}\n`);
  } finally {
    engine.close();
  }
}

export function rejectCommand(opts: { dir: string; id: string; note?: string }): void {
  const note = opts.note?.trim() ?? "";
  if (!note) throw new LedgerError("reason_required", "reject requires --note <reason>", 400);
  const engine = openLedger({ dir: opts.dir });
  try {
    const task = engine.getTask(opts.id);
    if (!task) throw new LedgerError("not_found", `task ${opts.id} not found`, 404);
    const result = engine.reject(opts.id, {
      approverPrincipalId: task.principalId,
      channel: "cli",
      assurance: "app_asserted",
      presentedHash: task.payloadHash,
      note,
      simulated: false,
    });
    process.stdout.write(`${result.task.id} ${result.task.state}\n`);
  } finally {
    engine.close();
  }
}
