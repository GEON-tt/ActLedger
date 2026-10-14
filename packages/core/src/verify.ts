import { commit, GENESIS_HASH } from "./canonical.js";
import { verifyEd25519, type KeySet } from "./crypto.js";
import { compareWithDrift, payloadHash, type Payload } from "./payload.js";
import { assuranceRank, isUserAssurance } from "./policy/schema.js";
import type { Receipt } from "./receipts.js";
import { receiptHash, unsignedReceipt } from "./receipts.js";
import {
  COMMIT_RE,
  ERROR_CODE_RE,
  payloadCommit,
  reasonAllowed,
  RECEIPT_V01,
  RECEIPT_V02,
  SHA_RE,
  textCommit,
  type ProofSecret,
  type SecretsEntry,
  type TaskSecretsEntry,
} from "./secrets.js";
import { canTransition, isState, isTerminal, type State } from "./states.js";

export interface VerifyFailure {
  seq?: number;
  id?: string;
  step: string;
  reason: string;
}

export interface VerifyWarning {
  code: string;
  message: string;
  count: number;
}

export interface VerifyStats {
  count: number;
  byMode: Record<string, number>;
  byAssurance: Record<string, number>;
  byVersion: Record<string, number>;
  unknown: number;
  violations: number;
  secrets?: { checked: number; shredded: number; missing: number };
}

export interface VerifyReport {
  ok: boolean;
  failure?: VerifyFailure;
  warnings: VerifyWarning[];
  stats: VerifyStats;
}

export interface VerifyOptions {
  secrets?: SecretsEntry[];
}

const COMMIT_KEYS = new Set([
  "payload_hash",
  "approved_payload_hash",
  "executed_hash",
  "presented_hash",
  "edited_payload_hash",
  "intent_commit",
  "message_commit",
  "note_commit",
  "description_commit",
]);

function emptyStats(): VerifyStats {
  return { count: 0, byMode: {}, byAssurance: {}, byVersion: {}, unknown: 0, violations: 0 };
}

function fail(receipt: Receipt | undefined, step: string, reason: string): VerifyFailure {
  return { seq: receipt?.seq, id: receipt?.id, step, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function checkStructure(receipt: Receipt): string | null {
  if (receipt.v !== RECEIPT_V01 && receipt.v !== RECEIPT_V02) return "unsupported receipt version";
  if (typeof receipt.id !== "string" || typeof receipt.app_id !== "string") return "missing id or app_id";
  if (!Number.isSafeInteger(receipt.seq) || receipt.seq < 1) return "seq must be a positive integer";
  if (typeof receipt.prev_hash !== "string" || typeof receipt.hash !== "string") return "missing hash";
  if (receipt.v === RECEIPT_V02 && (!SHA_RE.test(receipt.prev_hash) || !SHA_RE.test(receipt.hash))) {
    return "hash must be sha256";
  }
  if (receipt.task_id !== null && typeof receipt.task_id !== "string") return "task_id must be a string or null";
  if (receipt.transition !== null) {
    const from = receipt.transition?.from;
    const to = receipt.transition?.to;
    if (!receipt.transition || (from !== null && typeof from !== "string") || typeof to !== "string") {
      return "transition must be {from, to}";
    }
  }
  if (!isRecord(receipt.actor) || typeof receipt.actor.type !== "string" || typeof receipt.actor.id !== "string") {
    return "actor is required";
  }
  if (!isRecord(receipt.body) || !Array.isArray(receipt.evidence)) return "body and evidence are required";
  if (typeof receipt.issued_at !== "string") return "issued_at is required";
  if (receipt.sig?.alg !== "Ed25519" || typeof receipt.sig.kid !== "string" || typeof receipt.sig.value !== "string") {
    return "sig must be Ed25519";
  }
  return null;
}

function keyValid(keys: KeySet, receipt: Receipt): string | null {
  const key = keys.keys.find((item) => item.kid === receipt.sig.kid);
  if (!key) return `unknown kid ${receipt.sig.kid}`;
  if (key.retired_at && receipt.issued_at > key.retired_at) {
    return `kid ${key.kid} was retired at ${key.retired_at}`;
  }
  if (!verifyEd25519(key.public_key, receipt.hash, receipt.sig.value)) return "signature mismatch";
  return null;
}

function collectStats(receipts: Receipt[]): VerifyStats {
  const stats = emptyStats();
  stats.count = receipts.length;
  for (const receipt of receipts) {
    stats.byVersion[receipt.v] = (stats.byVersion[receipt.v] ?? 0) + 1;
    const integration = receipt.body.integration;
    if (isRecord(integration) && typeof integration.mode === "string") {
      stats.byMode[integration.mode] = (stats.byMode[integration.mode] ?? 0) + 1;
    }
    const approval = receipt.body.approval;
    if (isRecord(approval) && typeof approval.assurance === "string") {
      stats.byAssurance[approval.assurance] = (stats.byAssurance[approval.assurance] ?? 0) + 1;
    }
    if (receipt.transition?.to === "unknown") stats.unknown += 1;
    if (receipt.body.kind === "violation") stats.violations += 1;
  }
  return stats;
}

function hasV01Plaintext(receipt: Receipt): boolean {
  const body = receipt.body;
  if (isRecord(body.initiator) && "intent" in body.initiator) return true;
  if (isRecord(body.error) && "message" in body.error) return true;
  if ("note" in body) return true;
  if ("reason" in body && typeof body.reason === "string") {
    const to = receipt.transition?.to ?? "";
    if (!reasonAllowed(to, body.reason)) return true;
  }
  return false;
}

function collectWarnings(receipts: Receipt[]): VerifyWarning[] {
  let count = 0;
  for (const receipt of receipts) {
    if (receipt.v === RECEIPT_V01 && hasV01Plaintext(receipt)) count += 1;
  }
  if (count === 0) return [];
  return [{ code: "v01_plaintext", message: "含明文意图或错误信息", count }];
}

function checkVersions(receipts: Receipt[]): VerifyFailure | null {
  const seen = new Map<string, string>();
  for (const receipt of receipts) {
    if (!receipt.task_id) continue;
    const previous = seen.get(receipt.task_id);
    if (previous && previous !== receipt.v) {
      return fail(receipt, "version", `task ${receipt.task_id} mixes receipt versions`);
    }
    seen.set(receipt.task_id, receipt.v);
  }
  return null;
}

function checkPlaintext(receipt: Receipt): string | null {
  if (receipt.v !== RECEIPT_V02) return null;
  const body = receipt.body;
  if ("initiator" in body && !isRecord(body.initiator)) return "initiator must be an object";
  if ("approval" in body && !isRecord(body.approval)) return "approval must be an object";
  if ("error" in body && !isRecord(body.error)) return "error must be an object";
  if (isRecord(body.initiator) && "intent" in body.initiator) return "initiator.intent is plaintext";
  if ("note" in body) return "note is plaintext";
  if ("description" in body) return "description is plaintext";
  if ("result" in body) return "result is plaintext";
  if (isRecord(body.approval) && "note" in body.approval) return "approval.note is plaintext";
  if ("reason" in body) {
    const to = receipt.transition?.to ?? "";
    if (typeof body.reason !== "string" || !reasonAllowed(to, body.reason)) return "reason is not an enumerated value";
  }
  if (isRecord(body.error)) {
    if ("message" in body.error) return "error.message is plaintext";
    for (const key of Object.keys(body.error)) {
      if (key !== "code" && key !== "message_commit" && key !== "retryable") return `error.${key} is not allowed`;
    }
    if (typeof body.error.code !== "string" || !ERROR_CODE_RE.test(body.error.code)) return "error.code is invalid";
    if (typeof body.error.message_commit !== "string") return "error.message_commit is required";
    if ("retryable" in body.error && typeof body.error.retryable !== "boolean") return "error.retryable must be boolean";
  }
  return null;
}

function commitField(value: unknown, where: string): string | null {
  if (typeof value !== "string" || !COMMIT_RE.test(value)) return `${where} is not an hmac-sha256 commitment`;
  return null;
}

function checkCommitFields(body: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(body)) {
    if (!COMMIT_KEYS.has(key) || value == null) continue;
    const bad = commitField(value, key);
    if (bad) return bad;
  }
  if (isRecord(body.approval)) {
    for (const [key, value] of Object.entries(body.approval)) {
      if (!COMMIT_KEYS.has(key) || value == null) continue;
      const bad = commitField(value, `approval.${key}`);
      if (bad) return bad;
    }
  }
  if (isRecord(body.initiator) && "intent_commit" in body.initiator) {
    const bad = commitField(body.initiator.intent_commit, "initiator.intent_commit");
    if (bad) return bad;
  }
  if (isRecord(body.error) && "message_commit" in body.error) {
    const bad = commitField(body.error.message_commit, "error.message_commit");
    if (bad) return bad;
  }
  if (Array.isArray(body.external_proofs)) {
    for (const proof of body.external_proofs) {
      if (!isRecord(proof)) return "external_proofs commit is not an hmac-sha256 commitment";
      const bad = commitField(proof.commit, "external_proofs.commit");
      if (bad) return bad;
    }
  }
  return null;
}

function driftEmpty(value: unknown): boolean {
  return value == null || (Array.isArray(value) && value.length === 0);
}

function checkCommitments(receipts: Receipt[]): VerifyFailure | null {
  const byTask = new Map<string, Receipt[]>();
  for (const receipt of receipts) {
    if (receipt.v !== RECEIPT_V02 || !receipt.task_id) continue;
    const list = byTask.get(receipt.task_id) ?? [];
    list.push(receipt);
    byTask.set(receipt.task_id, list);
  }
  for (const [taskId, list] of byTask) {
    list.sort((a, b) => a.seq - b.seq);
    let payloadHashSeen: string | undefined;
    let intentSeen: string | undefined;
    let sawIntent = false;
    let approvedAtApproval: string | undefined;
    for (const receipt of list) {
      const body = receipt.body;
      const fields = checkCommitFields(body);
      if (fields) return fail(receipt, "commitments", fields);
      if (typeof body.payload_hash === "string") {
        if (payloadHashSeen === undefined) payloadHashSeen = body.payload_hash;
        else if (body.payload_hash !== payloadHashSeen) {
          return fail(receipt, "commitments", `task ${taskId} payload_hash changed`);
        }
        for (const evidence of receipt.evidence) {
          if (evidence.type === "payload" && evidence.sha256 !== body.payload_hash) {
            return fail(receipt, "commitments", "payload evidence does not match payload_hash");
          }
        }
      }
      if (isRecord(body.initiator)) {
        const present = "intent_commit" in body.initiator;
        const value = present && typeof body.initiator.intent_commit === "string" ? body.initiator.intent_commit : undefined;
        if (!sawIntent) {
          sawIntent = true;
          intentSeen = value;
        } else if (intentSeen !== value) {
          return fail(receipt, "commitments", `task ${taskId} intent_commit changed`);
        }
      }
      if (isRecord(body.approval)) {
        if (typeof body.approval.presented_hash === "string" && body.approval.presented_hash !== body.payload_hash) {
          return fail(receipt, "commitments", "presented_hash does not match payload_hash");
        }
        if (typeof body.approved_payload_hash === "string") {
          const edited = body.approval.edited_payload_hash;
          const expected = typeof edited === "string" ? edited : body.payload_hash;
          if (body.approved_payload_hash !== expected) {
            return fail(receipt, "commitments", "approved_payload_hash does not match the approval");
          }
        }
      }
      if (receipt.transition?.to === "approved" && typeof body.approved_payload_hash === "string") {
        approvedAtApproval = body.approved_payload_hash;
      }
    }
    for (const receipt of list) {
      const to = receipt.transition?.to;
      const approved = receipt.body.approved_payload_hash;
      if (
        (to === "executing" || to === "executed" || to === "failed") &&
        typeof approved === "string" &&
        approvedAtApproval !== undefined &&
        approved !== approvedAtApproval
      ) {
        return fail(receipt, "commitments", "approved_payload_hash does not match the approval");
      }
      if (typeof receipt.body.executed_hash === "string" && typeof receipt.body.approved_payload_hash === "string") {
        const same = receipt.body.executed_hash === receipt.body.approved_payload_hash;
        const empty = driftEmpty(receipt.body.drift_applied);
        if (same && (receipt.body.content_match !== true || !empty)) {
          return fail(receipt, "commitments", "executed_hash matches approved_payload_hash but drift is recorded");
        }
        if (receipt.body.content_match === true && !same && empty) {
          return fail(receipt, "commitments", "content_match requires drift_applied when hashes differ");
        }
      }
    }
  }
  for (const receipt of receipts) {
    if (receipt.v !== RECEIPT_V02) continue;
    const fields = checkCommitFields(receipt.body);
    if (fields) return fail(receipt, "commitments", fields);
  }
  return null;
}

function checkStateMachines(receipts: Receipt[]): VerifyFailure | null {
  const byTask = new Map<string, Receipt[]>();
  for (const receipt of receipts) {
    if (!receipt.task_id || !receipt.transition) continue;
    const list = byTask.get(receipt.task_id) ?? [];
    list.push(receipt);
    byTask.set(receipt.task_id, list);
  }
  for (const [taskId, list] of byTask) {
    list.sort((a, b) => a.seq - b.seq);
    const first = list[0];
    if (first.transition?.from !== null || first.transition?.to !== "prepared") {
      return fail(first, "state_machine", `task ${taskId} does not start at prepared`);
    }
    let current: State = "prepared";
    let claims = 0;
    let terminals = 0;
    for (let i = 1; i < list.length; i++) {
      const receipt = list[i];
      const from = receipt.transition?.from;
      const to = receipt.transition?.to;
      if (typeof from !== "string" || typeof to !== "string" || !isState(from) || !isState(to)) {
        return fail(receipt, "state_machine", "transition endpoints must be states");
      }
      if (from !== current) {
        return fail(receipt, "state_machine", `task ${taskId} jumps from ${current} but receipt says ${from}`);
      }
      if (isTerminal(current)) {
        return fail(receipt, "state_machine", `task ${taskId} moved after terminal state ${current}`);
      }
      if (!canTransition(from, to)) {
        return fail(receipt, "state_machine", `illegal transition ${from} -> ${to}`);
      }
      if (from === "approved" && to === "executing") claims += 1;
      if (isTerminal(to)) terminals += 1;
      current = to;
    }
    if (claims > 1) return fail(list[0], "state_machine", `task ${taskId} was claimed more than once`);
    if (terminals > 1) return fail(list[0], "state_machine", `task ${taskId} has more than one terminal state`);
  }
  return null;
}

function checkSemantics(receipts: Receipt[]): VerifyFailure | null {
  const byTask = new Map<string, Receipt[]>();
  for (const receipt of receipts) {
    if (!receipt.task_id) continue;
    const list = byTask.get(receipt.task_id) ?? [];
    list.push(receipt);
    byTask.set(receipt.task_id, list);
  }
  for (const [, list] of byTask) {
    list.sort((a, b) => a.seq - b.seq);
    const executed = list.find((receipt) => receipt.transition?.to === "executed");
    const executing = list.find((receipt) => receipt.transition?.to === "executing");
    const approved = list.find((receipt) => receipt.transition?.to === "approved");
    if (executed) {
      const match = executed.body.content_match === true;
      const marked = executed.body.mismatch === true;
      if (!match && !marked) {
        return fail(executed, "semantics", "executed receipt is neither content_match nor mismatch");
      }
    }
    const approvedBody = approved && isRecord(approved.body.approval) ? approved.body.approval : null;
    if (approved && approvedBody) {
      const assurance = approvedBody.assurance;
      const approver = typeof approvedBody.approver === "string" ? approvedBody.approver : "";
      const policy = isRecord(approved.body.policy) ? approved.body.policy : null;
      const min = policy?.min_assurance;
      const hasMin = typeof min === "string";
      const policyAllow = !hasMin && approver.startsWith("policy:");
      if (hasMin) {
        const got = typeof assurance === "string" ? assuranceRank(assurance) : -1;
        const need = assuranceRank(min);
        if (!isUserAssurance(assurance) || need < 1 || got < need) {
          return fail(approved, "semantics", `assurance ${String(assurance)} is below required ${min}`);
        }
      }
      const auth = isRecord(approvedBody.auth) ? approvedBody.auth : null;
      if (typeof policy?.step_up === "string" && !approver.startsWith("policy:")) {
        if (!auth || auth.step_up !== policy.step_up || auth.simulated !== true) {
          return fail(approved, "semantics", "step-up does not match the policy requirement");
        }
      }
      if (auth && auth.step_up != null && auth.simulated !== true) {
        return fail(approved, "semantics", "step-up is simulated until a channel authenticator exists");
      }
      if (!policyAllow && assurance !== "policy") {
        const decidedAt = approvedBody.decided_at;
        if (typeof assurance !== "string" || typeof decidedAt !== "string") {
          return fail(approved, "semantics", "approval is missing assurance or decided_at");
        }
        if (executing && decidedAt > executing.issued_at) {
          return fail(executing, "semantics", "approval is later than execution");
        }
      }
    }
  }
  return null;
}

function sameDrift(actual: unknown, expected: string[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

function asPayload(value: unknown): Payload | null {
  if (!isRecord(value) || typeof value.action !== "string" || !isRecord(value.args)) return null;
  return value as unknown as Payload;
}

function checkTaskSecrets(receipts: Receipt[], entry: TaskSecretsEntry): VerifyFailure | null {
  if (entry.payload_salt == null) {
    const payload = asPayload(entry.payload);
    if (!payload) return fail(receipts[0], "secrets", "legacy secret is missing a payload");
    const expectedPayload = payloadHash(payload);
    const approvedSource = asPayload(entry.approved_payload) ?? payload;
    const expectedApproved = payloadHash(approvedSource);
    const executedSource = asPayload(entry.executed_payload);
    for (const receipt of receipts) {
      if (typeof receipt.body.payload_hash === "string" && receipt.body.payload_hash !== expectedPayload) {
        return fail(receipt, "secrets", "payload_hash does not match the secret");
      }
      if (typeof receipt.body.approved_payload_hash === "string" && receipt.body.approved_payload_hash !== expectedApproved) {
        return fail(receipt, "secrets", "approved_payload_hash does not match the secret");
      }
      // Schema 1 did not store the executed payload, so these checks are skipped when it is absent.
      if (executedSource && typeof receipt.body.executed_hash === "string" && receipt.body.executed_hash !== payloadHash(executedSource)) {
        return fail(receipt, "secrets", "executed_hash does not match the secret");
      }
      if (executedSource && "content_match" in receipt.body) {
        const comparison = compareWithDrift(approvedSource, executedSource);
        if (receipt.body.content_match !== comparison.match || !sameDrift(receipt.body.drift_applied, comparison.driftApplied)) {
          return fail(receipt, "secrets", "content_match does not match the secret payloads");
        }
      }
      const proofError = checkProofSecrets(receipt, entry.proofs);
      if (proofError) return fail(receipt, "secrets", proofError);
    }
    return null;
  }
  const salt = Buffer.from(entry.payload_salt, "base64url");
  const payload = asPayload(entry.payload);
  if (!payload) return fail(receipts[0], "secrets", "secret is missing a payload");
  const expectedPayload = payloadCommit(salt, payload);
  const approvedSource = asPayload(entry.approved_payload) ?? payload;
  const expectedApproved = payloadCommit(salt, approvedSource);
  const executedSource = asPayload(entry.executed_payload);
  for (const receipt of receipts) {
    if (typeof receipt.body.payload_hash === "string" && receipt.body.payload_hash !== expectedPayload) {
      return fail(receipt, "secrets", "payload_hash does not match the secret");
    }
    if (typeof receipt.body.approved_payload_hash === "string" && receipt.body.approved_payload_hash !== expectedApproved) {
      return fail(receipt, "secrets", "approved_payload_hash does not match the secret");
    }
    const initiator = receipt.body.initiator;
    if (isRecord(initiator) && typeof initiator.intent_commit === "string") {
      if (typeof entry.intent !== "string" || textCommit(salt, entry.intent) !== initiator.intent_commit) {
        return fail(receipt, "secrets", "intent_commit does not match the secret");
      }
    }
    if (typeof receipt.body.executed_hash === "string") {
      if (!executedSource || receipt.body.executed_hash !== payloadCommit(salt, executedSource)) {
        return fail(receipt, "secrets", "executed_hash does not match the secret");
      }
    }
    if (executedSource && "content_match" in receipt.body) {
      const comparison = compareWithDrift(approvedSource, executedSource);
      if (receipt.body.content_match !== comparison.match || !sameDrift(receipt.body.drift_applied, comparison.driftApplied)) {
        return fail(receipt, "secrets", "content_match does not match the secret payloads");
      }
    }
    const error = receipt.body.error;
    if (isRecord(error) && typeof error.message_commit === "string") {
      if (!entry.error || textCommit(salt, entry.error.message) !== error.message_commit || error.code !== entry.error.code) {
        return fail(receipt, "secrets", "error commitment does not match the secret");
      }
    }
    if (typeof receipt.body.note_commit === "string") {
      const to = receipt.transition?.to;
      const note =
        to === "rejected"
          ? entry.notes?.reject
          : to === "revoked"
            ? entry.notes?.revoke
            : to === "failed" || receipt.body.reconciled === true
              ? entry.notes?.reconcile
              : null;
      if (note == null || textCommit(salt, note) !== receipt.body.note_commit) {
        return fail(receipt, "secrets", "note_commit does not match the secret");
      }
    }
    const proofError = checkProofSecrets(receipt, entry.proofs);
    if (proofError) return fail(receipt, "secrets", proofError);
  }
  return null;
}

function checkProofSecrets(receipt: Receipt, proofs: ProofSecret[] | undefined): string | null {
  const ext = receipt.body.external_proofs;
  if (!Array.isArray(ext) || ext.length === 0) return null;
  for (let index = 0; index < ext.length; index++) {
    const item = ext[index];
    const proof = proofs?.find((candidate) => candidate.index === index) ?? proofs?.[index];
    if (!isRecord(item) || !proof) return "missing proof secret";
    const mac = commit(Buffer.from(proof.salt, "base64url"), proof.value);
    if (mac !== item.commit) return "proof commitment does not match the secret";
    if (typeof proof.type === "string" && proof.type !== item.type) return "proof commitment does not match the secret";
  }
  return null;
}

function checkSecrets(
  receipts: Receipt[],
  secrets: SecretsEntry[],
): { failure: VerifyFailure | null; stats: { checked: number; shredded: number; missing: number } } {
  const stats = { checked: 0, shredded: 0, missing: 0 };
  const byTask = new Map<string, Receipt[]>();
  for (const receipt of receipts) {
    if (!receipt.task_id) continue;
    const list = byTask.get(receipt.task_id) ?? [];
    list.push(receipt);
    byTask.set(receipt.task_id, list);
  }
  const secretByTask = new Map<string, TaskSecretsEntry>();
  for (const entry of secrets) {
    if (entry.kind === "task") secretByTask.set(entry.task_id, entry);
  }
  for (const [taskId, list] of byTask) {
    const entry = secretByTask.get(taskId);
    if (!entry) {
      stats.missing += 1;
      continue;
    }
    if (entry.shredded) {
      stats.shredded += 1;
      continue;
    }
    stats.checked += 1;
    const failure = checkTaskSecrets(list, entry);
    if (failure) return { failure, stats };
  }
  for (const receipt of receipts) {
    if (receipt.body.kind !== "violation") continue;
    const entry = secrets.find((item) => item.kind === "violation" && item.receipt_id === receipt.id);
    if (!entry || entry.kind !== "violation") {
      stats.missing += 1;
      continue;
    }
    stats.checked += 1;
    const mac = textCommit(Buffer.from(entry.salt, "base64url"), entry.description);
    if (mac !== receipt.body.description_commit) {
      return { failure: fail(receipt, "secrets", "violation description does not match the secret"), stats };
    }
  }
  return { failure: null, stats };
}

export function verifyReceiptChain(receipts: Receipt[], keys: KeySet, opts?: VerifyOptions): VerifyReport {
  const ordered = [...receipts].sort((a, b) => a.seq - b.seq);
  const stats = collectStats(ordered);
  const warnings = collectWarnings(ordered);
  if (ordered.length === 0) return { ok: true, warnings, stats };
  for (let i = 0; i < ordered.length; i++) {
    const receipt = ordered[i];
    const structure = checkStructure(receipt);
    if (structure) return { ok: false, failure: fail(receipt, "structure", structure), warnings, stats };
    if (receiptHash(unsignedReceipt(receipt)) !== receipt.hash) {
      return { ok: false, failure: fail(receipt, "hash", "hash does not match the canonical receipt"), warnings, stats };
    }
    const signature = keyValid(keys, receipt);
    if (signature) return { ok: false, failure: fail(receipt, "signature", signature), warnings, stats };
    if (i === 0) {
      if (receipt.seq !== 1) {
        return { ok: false, failure: fail(receipt, "chain", "export must start at seq 1"), warnings, stats };
      }
      if (receipt.prev_hash !== GENESIS_HASH) {
        return { ok: false, failure: fail(receipt, "chain", "genesis prev_hash mismatch"), warnings, stats };
      }
    } else {
      const prev = ordered[i - 1];
      if (receipt.seq !== prev.seq + 1) {
        return { ok: false, failure: fail(receipt, "chain", `seq gap after ${prev.seq}`), warnings, stats };
      }
      if (receipt.prev_hash !== prev.hash) {
        return { ok: false, failure: fail(receipt, "chain", "prev_hash does not match the previous receipt"), warnings, stats };
      }
    }
  }
  const versions = checkVersions(ordered);
  if (versions) return { ok: false, failure: versions, warnings, stats };
  for (const receipt of ordered) {
    const plaintext = checkPlaintext(receipt);
    if (plaintext) return { ok: false, failure: fail(receipt, "plaintext", plaintext), warnings, stats };
  }
  const commitments = checkCommitments(ordered);
  if (commitments) return { ok: false, failure: commitments, warnings, stats };
  const machine = checkStateMachines(ordered);
  if (machine) return { ok: false, failure: machine, warnings, stats };
  const semantic = checkSemantics(ordered);
  if (semantic) return { ok: false, failure: semantic, warnings, stats };
  if (opts?.secrets) {
    const checked = checkSecrets(ordered, opts.secrets);
    stats.secrets = checked.stats;
    if (checked.failure) return { ok: false, failure: checked.failure, warnings, stats };
  }
  return { ok: true, warnings, stats };
}

export function parseReceiptJsonl(text: string): Receipt[] {
  const receipts: Receipt[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    receipts.push(JSON.parse(trimmed) as Receipt);
  }
  return receipts;
}

export function verifyJsonl(text: string, keys: KeySet, opts?: VerifyOptions): VerifyReport {
  return verifyReceiptChain(parseReceiptJsonl(text), keys, opts);
}

/** Hash and signature only, for rendering a single receipt. */
export function checkReceipt(receipt: Receipt, keys: KeySet): { ok: boolean; reason?: string } {
  const structure = checkStructure(receipt);
  if (structure) return { ok: false, reason: structure };
  if (receiptHash(unsignedReceipt(receipt)) !== receipt.hash) return { ok: false, reason: "hash mismatch" };
  const signature = keyValid(keys, receipt);
  if (signature) return { ok: false, reason: signature };
  return { ok: true };
}
