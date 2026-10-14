import { Buffer } from "node:buffer";
import {
  LedgerError,
  commit,
  compareWithDrift,
  jcs,
  parseSecretsJsonl,
  verifyJsonl,
  type KeySet,
  type Payload,
} from "@actledger/core";

interface Named {
  name: string;
}

interface VerifyInput extends Named {
  receipts: string;
  keys: string;
  secrets: string | null;
}

interface JsonInput extends Named {
  json: string;
}

interface CommitInput extends Named {
  salt_hex: string;
  json: string;
}

interface TextInput extends Named {
  text: string;
}

interface DriftInput extends Named {
  approved: string;
  executed: string;
}

interface ParityInput {
  verify?: VerifyInput[];
  jcs?: JsonInput[];
  commit?: CommitInput[];
  b64?: TextInput[];
  drift?: DriftInput[];
}

function errorOf(error: unknown): { code: string; message: string } {
  if (error instanceof LedgerError) return { code: error.code, message: error.message };
  return { code: "throw", message: String(error) };
}

function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

const input = JSON.parse(await readStdin()) as ParityInput;

const verify = (input.verify ?? []).map((item) => {
  try {
    const keys = JSON.parse(item.keys) as KeySet;
    const secrets = item.secrets == null ? undefined : parseSecretsJsonl(item.secrets);
    const report = verifyJsonl(item.receipts, keys, secrets ? { secrets } : undefined);
    return { name: item.name, report };
  } catch (error) {
    return { name: item.name, error: errorOf(error) };
  }
});

const jcsResults = (input.jcs ?? []).map((item) => {
  try {
    return { name: item.name, jcs: jcs(JSON.parse(item.json)) };
  } catch (error) {
    return { name: item.name, error: errorOf(error) };
  }
});

const commitResults = (input.commit ?? []).map((item) => {
  try {
    return { name: item.name, commit: commit(Buffer.from(item.salt_hex, "hex"), JSON.parse(item.json)) };
  } catch (error) {
    return { name: item.name, error: errorOf(error) };
  }
});

const b64 = (input.b64 ?? []).map((item) => {
  try {
    return { name: item.name, hex: Buffer.from(item.text, "base64url").toString("hex") };
  } catch (error) {
    return { name: item.name, error: errorOf(error) };
  }
});

const drift = (input.drift ?? []).map((item) => {
  try {
    const result = compareWithDrift(JSON.parse(item.approved) as Payload, JSON.parse(item.executed) as Payload);
    return { name: item.name, match: result.match, driftApplied: result.driftApplied };
  } catch (error) {
    return { name: item.name, error: errorOf(error) };
  }
});

process.stdout.write(JSON.stringify({ verify, jcs: jcsResults, commit: commitResults, b64, drift }));
