import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { sha256 } from '../util/misc.js';

export interface ApiKeyRecord {
  id: string;
  name: string;
  keyHash: string;
  prefix: string;
  rpm: number | null;
  tokensPerDay: number | null;
  monthlyBudgetUsd: number | null;
  allowedAliases: string[] | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface NewKeyInput {
  name: string;
  rpm?: number | null;
  tokensPerDay?: number | null;
  monthlyBudgetUsd?: number | null;
  allowedAliases?: string[] | null;
}

export interface KeyStore {
  findByHash(hash: string): Promise<ApiKeyRecord | null>;
  create(input: NewKeyInput, plaintext?: string): Promise<{ record: ApiKeyRecord; plaintext: string }>;
  list(): Promise<ApiKeyRecord[]>;
  revoke(id: string): Promise<boolean>;
}

export function generateKey(): string {
  return `tg_${randomBytes(24).toString('base64url')}`;
}

export function buildRecord(input: NewKeyInput, plaintext: string): ApiKeyRecord {
  return {
    id: randomUUID(),
    name: input.name,
    keyHash: sha256(plaintext),
    prefix: plaintext.slice(0, 8),
    rpm: input.rpm ?? null,
    tokensPerDay: input.tokensPerDay ?? null,
    monthlyBudgetUsd: input.monthlyBudgetUsd ?? null,
    allowedAliases: input.allowedAliases ?? null,
    createdAt: new Date().toISOString(),
    revokedAt: null,
  };
}

export class MemoryKeyStore implements KeyStore {
  private readonly records = new Map<string, ApiKeyRecord>();

  async findByHash(hash: string): Promise<ApiKeyRecord | null> {
    for (const record of this.records.values()) {
      if (record.keyHash === hash) return record;
    }
    return null;
  }

  async create(input: NewKeyInput, plaintext = generateKey()) {
    const record = buildRecord(input, plaintext);
    this.records.set(record.id, record);
    return { record, plaintext };
  }

  async list(): Promise<ApiKeyRecord[]> {
    return [...this.records.values()];
  }

  async revoke(id: string): Promise<boolean> {
    const record = this.records.get(id);
    if (!record || record.revokedAt) return false;
    record.revokedAt = new Date().toISOString();
    return true;
  }
}

export class CachedKeyStore implements KeyStore {
  private readonly cache = new Map<string, { record: ApiKeyRecord | null; expires: number }>();

  constructor(
    private readonly inner: KeyStore,
    private readonly ttlMs = 15_000,
    private readonly now: () => number = Date.now,
  ) {}

  async findByHash(hash: string): Promise<ApiKeyRecord | null> {
    const hit = this.cache.get(hash);
    if (hit && hit.expires > this.now()) return hit.record;
    const record = await this.inner.findByHash(hash);
    this.cache.set(hash, { record, expires: this.now() + this.ttlMs });
    if (this.cache.size > 10_000) this.cache.clear();
    return record;
  }

  create(input: NewKeyInput, plaintext?: string) {
    return this.inner.create(input, plaintext);
  }

  list() {
    return this.inner.list();
  }

  async revoke(id: string): Promise<boolean> {
    const ok = await this.inner.revoke(id);
    this.cache.clear();
    return ok;
  }
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(sha256(a));
  const bb = Buffer.from(sha256(b));
  return timingSafeEqual(ab, bb);
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}
