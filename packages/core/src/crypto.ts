import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

/** SPKI prefix for a 32-byte Ed25519 public key. */
export const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface Signer {
  kid: string;
  sign(message: string): string;
}

export interface PublicKeyRecord {
  kid: string;
  alg: "Ed25519";
  public_key: string;
  created_at: string;
  retired_at: string | null;
}

export interface KeySet {
  keys: PublicKeyRecord[];
}

export function generateEd25519(): { publicKeyRaw: Buffer; privatePem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  const raw = Buffer.from(der.subarray(der.length - 32));
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return { publicKeyRaw: raw, privatePem };
}

export function signerFromPem(kid: string, pem: string): Signer {
  const key = createPrivateKey(pem);
  return {
    kid,
    sign(message: string): string {
      return sign(null, Buffer.from(message, "utf8"), key).toString("base64url");
    },
  };
}

export function publicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) {
    throw new Error(`ed25519 public key must be 32 bytes, got ${raw.length}`);
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

export function verifyEd25519(publicKeyB64url: string, message: string, sigB64url: string): boolean {
  try {
    const raw = Buffer.from(publicKeyB64url, "base64url");
    const key = publicKeyFromRaw(raw);
    return verify(null, Buffer.from(message, "utf8"), key, Buffer.from(sigB64url, "base64url"));
  } catch {
    return false;
  }
}

export function encryptAesGcm(key: Buffer, plaintext: Buffer): { nonce: string; ciphertext: string } {
  if (key.length !== 32) throw new Error("AES-256-GCM key must be 32 bytes");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    nonce: nonce.toString("base64url"),
    ciphertext: Buffer.concat([enc, tag]).toString("base64url"),
  };
}

export function decryptAesGcm(key: Buffer, nonceB64: string, ciphertextB64: string): Buffer {
  const nonce = Buffer.from(nonceB64, "base64url");
  const blob = Buffer.from(ciphertextB64, "base64url");
  const tag = blob.subarray(blob.length - 16);
  const data = blob.subarray(0, blob.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export function randomKey(): Buffer {
  return randomBytes(32);
}
