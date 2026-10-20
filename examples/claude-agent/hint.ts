export function approveInstructions(dir: string): string {
  return `approve from another terminal: pnpm actledger tasks --dir ${dir} --state pending_approval && pnpm actledger approve <task id> --dir ${dir}\n`;
}
