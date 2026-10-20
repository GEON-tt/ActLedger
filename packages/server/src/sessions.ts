import { randomBytes } from "node:crypto";
import type { UserRow } from "./store.js";
import type { CredentialStore } from "./store.js";

export const SESSION_IDLE_MS = 30 * 60_000;
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60_000;

export interface RemoteSession {
  id: string;
  csrf: string;
  userId: string;
  username: string;
  principalId: string;
}

interface StoredSession {
  csrf: string;
  userId: string;
  username: string;
  principalId: string;
  epoch: number;
  createdAt: number;
  lastSeen: number;
}

export class RemoteSessions {
  private readonly sessions = new Map<string, StoredSession>();

  constructor(
    private readonly now: () => Date,
    private readonly store: CredentialStore,
  ) {}

  create(user: UserRow): RemoteSession {
    const id = randomBytes(32).toString("base64url");
    const csrf = randomBytes(32).toString("base64url");
    const ts = this.now().getTime();
    this.sessions.set(id, {
      csrf,
      userId: user.id,
      username: user.username,
      principalId: user.principalId,
      epoch: user.sessionEpoch,
      createdAt: ts,
      lastSeen: ts,
    });
    return { id, csrf, userId: user.id, username: user.username, principalId: user.principalId };
  }

  get(id: string | undefined): RemoteSession | null {
    if (!id) return null;
    const row = this.sessions.get(id);
    if (!row) return null;
    const ts = this.now().getTime();
    if (ts - row.createdAt >= SESSION_ABSOLUTE_MS || ts - row.lastSeen >= SESSION_IDLE_MS) {
      this.sessions.delete(id);
      return null;
    }
    const user = this.store.getUser(row.userId);
    if (!user || user.sessionEpoch !== row.epoch) {
      this.sessions.delete(id);
      return null;
    }
    row.lastSeen = ts;
    return {
      id,
      csrf: row.csrf,
      userId: row.userId,
      username: row.username,
      principalId: row.principalId,
    };
  }

  destroy(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }
}
