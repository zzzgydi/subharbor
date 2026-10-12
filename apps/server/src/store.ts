import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { eq, and } from 'drizzle-orm';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const records = sqliteTable('records', {
  kind: text('kind').notNull(),
  id: text('id').primaryKey(),
  revision: integer('revision').notNull(),
  payload: text('payload').notNull(),
});
export class Conflict extends Error {
  statusCode = 409;
  constructor() {
    super('内容已更新，请重新加载后再保存');
  }
}
export class Store {
  readonly sqlite: Database.Database;
  private db: ReturnType<typeof drizzle>;
  readonly fingerprintKey: Buffer;
  private encryptionKey: Buffer;
  constructor(dataDir: string, key: Buffer) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = join(dataDir, 'subharbor.sqlite');
    this.sqlite = new Database(file);
    chmodSync(file, 0o600);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    const version = this.sqlite.pragma('user_version', { simple: true }) as number;
    if (version > 1) throw new Error('数据库版本比当前应用新，不能直接降级');
    this.sqlite.exec(
      'CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS records_kind ON records(kind); PRAGMA user_version = 1;',
    );
    this.db = drizzle(this.sqlite);
    this.encryptionKey = Buffer.from(hkdfSync('sha256', key, '', 'subharbor:data:v1', 32));
    this.fingerprintKey = Buffer.from(hkdfSync('sha256', key, '', 'subharbor:fingerprint:v1', 32));
    const marker = this.get<{ id: string; value: string }>('system', 'key-check');
    if (!marker) this.save('system', { id: 'key-check', value: 'subharbor-v1' });
    else if (marker.value !== 'subharbor-v1') throw new Error('数据密钥不匹配');
  }
  private encrypt(kind: string, id: string, value: unknown): string {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(kind + ':' + id));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  private decrypt<T>(kind: string, id: string, value: string): T {
    try {
      const bytes = Buffer.from(value, 'base64'),
        decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(kind + ':' + id));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(
        Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'),
      ) as T;
    } catch {
      throw new Error('无法解密数据，请检查主密钥与备份版本');
    }
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db
      .select()
      .from(records)
      .where(and(eq(records.kind, kind), eq(records.id, id)))
      .get();
    return row ? this.decrypt<T>(kind, id, row.payload) : undefined;
  }
  list<T>(kind: string): T[] {
    return this.db
      .select()
      .from(records)
      .where(eq(records.kind, kind))
      .all()
      .map((row) => this.decrypt<T>(kind, row.id, row.payload));
  }
  save<T extends { id: string; revision?: number }>(
    kind: string,
    value: T,
    expected?: number,
  ): void {
    const payload = this.encrypt(kind, value.id, value);
    if (expected !== undefined) {
      const result = this.db
        .update(records)
        .set({ payload, revision: value.revision || 0 })
        .where(
          and(eq(records.kind, kind), eq(records.id, value.id), eq(records.revision, expected)),
        )
        .run();
      if (result.changes !== 1) throw new Conflict();
    } else
      this.db
        .insert(records)
        .values({ kind, id: value.id, revision: value.revision || 0, payload })
        .onConflictDoUpdate({
          target: records.id,
          set: { kind, payload, revision: value.revision || 0 },
        })
        .run();
  }
  delete(kind: string, id: string): void {
    this.db
      .delete(records)
      .where(and(eq(records.kind, kind), eq(records.id, id)))
      .run();
  }
  transaction<T>(fn: () => T): T {
    return this.sqlite.transaction(fn)();
  }
  exportBackup(): unknown {
    return { format: 'subharbor-encrypted-v1', rows: this.db.select().from(records).all() };
  }
  restoreBackup(input: unknown): void {
    const value = input as { format?: unknown; rows?: any[] };
    if (
      value?.format !== 'subharbor-encrypted-v1' ||
      !Array.isArray(value.rows) ||
      value.rows.length > 100000
    )
      throw new Error('备份格式无效');
    const ids = new Set<string>();
    for (const row of value.rows) {
      if (
        !row ||
        typeof row.id !== 'string' ||
        !['system', 'source', 'rule-pack', 'config', 'script', 'share', 'artifact', 'job'].includes(
          row.kind,
        ) ||
        typeof row.payload !== 'string' ||
        !Number.isInteger(row.revision) ||
        ids.has(row.id)
      )
        throw new Error('备份记录无效');
      const decoded = this.decrypt<{ id?: string }>(row.kind, row.id, row.payload);
      if (decoded.id !== row.id) throw new Error('备份记录 ID 不匹配');
      ids.add(row.id);
    }
    if (!value.rows.some((r) => r.kind === 'system' && r.id === 'key-check'))
      throw new Error('备份缺少密钥校验记录');
    this.transaction(() => {
      this.db.delete(records).run();
      for (const row of value.rows!)
        this.db
          .insert(records)
          .values({ id: row.id, kind: row.kind, revision: row.revision, payload: row.payload })
          .run();
    });
  }
  close(): void {
    this.sqlite.close();
  }
}
