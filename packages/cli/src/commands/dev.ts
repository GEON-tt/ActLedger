import { openLedger, type LedgerEngine } from "@actledger/core";

function shownIntent(engine: LedgerEngine, taskId: string): string {
  try {
    return engine.taskIntent(taskId) ?? "";
  } catch {
    return "";
  }
}

export function devCommand(opts: { dir: string; once: boolean }): void {
  const engine = openLedger({ dir: opts.dir });
  const seen = new Set<string>();
  const tick = () => {
    const swept = engine.sweep();
    if (swept.expired.length > 0 || swept.unknown.length > 0) {
      process.stderr.write(`sweep expired=${swept.expired.join(",") || "-"} unknown=${swept.unknown.join(",") || "-"}\n`);
    }
    for (const warning of engine.policyInfo().warnings) {
      process.stderr.write(`warning: ${warning.message}\n`);
    }
    for (const task of engine.listTasks({ state: "pending_approval" })) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      process.stderr.write(`pending ${task.id} ${task.action.type} ${shownIntent(engine, task.id)}\n`);
    }
  };
  tick();
  if (opts.once) {
    engine.close();
    return;
  }
  const timer = setInterval(tick, 1000);
  process.on("SIGINT", () => {
    clearInterval(timer);
    engine.close();
    process.exit(0);
  });
}

export function tasksCommand(opts: { dir: string; state?: string; json: boolean }): void {
  const engine = openLedger({ dir: opts.dir });
  try {
    const tasks = engine.listTasks(opts.state ? { state: opts.state as never } : undefined);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(tasks, null, 2)}\n`);
      return;
    }
    if (tasks.length === 0) {
      process.stdout.write("no tasks\n");
      return;
    }
    for (const task of tasks) {
      process.stdout.write(`${task.id}\t${task.state}\t${task.action.type}\t${task.principalId}\t${shownIntent(engine, task.id)}\n`);
    }
  } finally {
    engine.close();
  }
}
