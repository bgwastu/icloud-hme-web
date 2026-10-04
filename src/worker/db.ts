import type { Alias, Connection, Operation, Snapshot } from "../shared/types";
import type { RemoteAlias } from "./icloud/client";
import { AppError, messageFor } from "./errors";
import { hash } from "./crypto";

export interface ConnectionRow {
  id: string;
  owner_id: string;
  account_id: string;
  account_email: string;
  region: "global" | "china";
  cookies_cipher: string;
  service_url: string;
  client_id: string;
  status: string;
  session_version: number;
  last_sync: string | null;
  last_error: string | null;
  lease_token: string | null;
  lease_expires: number;
  created_at: string;
  updated_at: string;
}
export interface AliasRow {
  id: string;
  connection_id: string;
  provider_id: string;
  email: string;
  label: string;
  note: string | null;
  active: number;
  provider_created_at: string | null;
  version: string;
  verified_at: string;
  deleted_at: string | null;
}
export interface OperationRow {
  id: string;
  connection_id: string;
  operation_key: string;
  request_hash: string;
  action: string;
  alias_id: string | null;
  candidate: string | null;
  payload: string;
  phase: string;
  status: string;
  error_code: string | null;
  result: string | null;
  created_at: string;
  updated_at: string;
}
export const publicConnection = (
  row: ConnectionRow | null,
): Connection | null =>
  row && {
    id: row.id,
    accountEmail: row.account_email,
    region: row.region,
    status: row.status,
    lastSync: row.last_sync,
    lastError: row.last_error,
  };
export const publicAlias = (row: AliasRow): Alias => ({
  id: row.id,
  email: row.email,
  label: row.label,
  note: row.note,
  active: Boolean(row.active),
  version: row.version,
  verifiedAt: row.verified_at,
  createdAt: row.provider_created_at,
});
export const publicOperation = (row: OperationRow): Operation => ({
  id: row.id,
  action: row.action,
  status: row.status,
  phase: row.phase,
  errorCode: row.error_code,
  updatedAt: row.updated_at,
  aliasId: row.alias_id,
});
export const metadataVersion = (alias: RemoteAlias) =>
  hash([alias.email, alias.label, alias.note, alias.active]);

export class Store {
  constructor(
    public db: D1Database,
    public owner: string,
    public leaseToken?: string,
  ) {}
  connection() {
    return this.db
      .prepare("SELECT * FROM connections WHERE owner_id = ?")
      .bind(this.owner)
      .first<ConnectionRow>();
  }
  async requireConnection() {
    const row = await this.connection();
    if (!row)
      throw new AppError("not_connected", "Connect iCloud to continue.", 409);
    return row;
  }
  async acquire(row: ConnectionRow) {
    const token = crypto.randomUUID(),
      now = Date.now();
    const result = await this.db
      .prepare(
        "UPDATE connections SET lease_token = ?, lease_expires = ? WHERE id = ? AND (lease_token IS NULL OR lease_expires < ?)",
      )
      .bind(token, now + 180_000, row.id, now)
      .run();
    if (!result.meta.changes)
      throw new AppError("busy", messageFor("busy"), 409);
    this.leaseToken = token;
    return token;
  }
  async assertLease(id: string) {
    const exists = await this.db
      .prepare(
        "SELECT id FROM connections WHERE id = ? AND lease_token = ? AND lease_expires > ?",
      )
      .bind(id, this.leaseToken ?? "", Date.now())
      .first();
    if (!exists)
      throw new AppError("unknown_outcome", messageFor("unknown_outcome"), 409);
  }
  async release(id: string) {
    await this.db
      .prepare(
        "UPDATE connections SET lease_token = NULL, lease_expires = 0 WHERE id = ? AND lease_token = ?",
      )
      .bind(id, this.leaseToken ?? "")
      .run();
  }
  guard() {
    return "EXISTS (SELECT 1 FROM connections WHERE id = ? AND lease_token = ? AND lease_expires > ?)";
  }
  guardValues(id: string) {
    return [id, this.leaseToken ?? "", Date.now()];
  }
  async saveSession(
    row: ConnectionRow,
    cipher: string,
    status = "connected",
    error: string | null = null,
  ) {
    const result = await this.db
      .prepare(
        `UPDATE connections SET cookies_cipher = ?, status = ?, last_error = ?, updated_at = ? WHERE id = ? AND ${this.guard()}`,
      )
      .bind(
        cipher,
        status,
        error,
        new Date().toISOString(),
        row.id,
        ...this.guardValues(row.id),
      )
      .run();
    if (!result.meta.changes)
      throw new AppError("unknown_outcome", messageFor("unknown_outcome"), 409);
  }
  async saveService(row: ConnectionRow, serviceUrl: string) {
    const result = await this.db
      .prepare(
        `UPDATE connections SET service_url = ? WHERE id = ? AND ${this.guard()}`,
      )
      .bind(serviceUrl, row.id, ...this.guardValues(row.id))
      .run();
    if (!result.meta.changes)
      throw new AppError("unknown_outcome", messageFor("unknown_outcome"), 409);
  }
  async snapshot(): Promise<Snapshot> {
    const rows = await this.db.batch([
      this.db
        .prepare("SELECT * FROM connections WHERE owner_id = ?")
        .bind(this.owner),
      this.db
        .prepare(
          "SELECT * FROM aliases WHERE connection_id IN (SELECT id FROM connections WHERE owner_id = ?) AND deleted_at IS NULL ORDER BY provider_created_at DESC, email COLLATE NOCASE, id",
        )
        .bind(this.owner),
      this.db
        .prepare(
          "SELECT * FROM operations WHERE connection_id IN (SELECT id FROM connections WHERE owner_id = ?) AND status IN ('pending','running','needs_verification') ORDER BY created_at",
        )
        .bind(this.owner),
    ]);
    return {
      connection: publicConnection(
        (rows[0].results[0] ?? null) as ConnectionRow | null,
      ),
      aliases: (rows[1].results as unknown as AliasRow[]).map(publicAlias),
      operations: (rows[2].results as unknown as OperationRow[]).map(
        publicOperation,
      ),
    };
  }
  async alias(id: string): Promise<AliasRow> {
    const row = await this.db
      .prepare(
        "SELECT * FROM aliases WHERE id = ? AND connection_id IN (SELECT id FROM connections WHERE owner_id = ?) AND deleted_at IS NULL",
      )
      .bind(id, this.owner)
      .first<AliasRow>();
    if (!row)
      throw new AppError(
        "not_found",
        "Address not found.",
        404,
      );
    return row;
  }
  async upsert(connectionId: string, alias: RemoteAlias): Promise<AliasRow> {
    const now = new Date().toISOString(),
      version = await metadataVersion(alias);
    await this.db
      .prepare(
        `INSERT INTO aliases (id,connection_id,provider_id,email,label,note,active,provider_created_at,version,verified_at)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${this.guard()}
      ON CONFLICT(connection_id,provider_id) DO UPDATE SET email=excluded.email,label=excluded.label,note=COALESCE(excluded.note,aliases.note),
      active=excluded.active,provider_created_at=COALESCE(excluded.provider_created_at,aliases.provider_created_at),version=excluded.version,verified_at=excluded.verified_at,deleted_at=NULL`,
      )
      .bind(
        crypto.randomUUID(),
        connectionId,
        alias.providerId,
        alias.email,
        alias.label,
        alias.note,
        Number(alias.active),
        alias.createdAt,
        version,
        now,
        ...this.guardValues(connectionId),
      )
      .run();
    await this.assertLease(connectionId);
    return (await this.db
      .prepare(
        "SELECT * FROM aliases WHERE connection_id = ? AND provider_id = ?",
      )
      .bind(connectionId, alias.providerId)
      .first<AliasRow>())!;
  }
  async sync(row: ConnectionRow, aliases: RemoteAlias[]) {
    const syncId = crypto.randomUUID(),
      now = new Date().toISOString();
    const records = await Promise.all(
      aliases.map(async (alias) => ({
        ...alias,
        version: await metadataVersion(alias),
      })),
    );
    await this.db
      .prepare(
        `DELETE FROM sync_items WHERE connection_id = ? AND ${this.guard()}`,
      )
      .bind(row.id, ...this.guardValues(row.id))
      .run();
    const chunks: string[] = [],
      encoder = new TextEncoder();
    let chunk: string[] = [],
      bytes = 2;
    for (const record of records) {
      const json = JSON.stringify(record),
        size = encoder.encode(json).byteLength + 1;
      if (size > 1_000_000)
        throw new AppError(
          "malformed_response",
          "iCloud returned metadata too large to sync safely. Your cached addresses are preserved.",
          502,
        );
      if (chunk.length && (chunk.length >= 100 || bytes + size > 1_000_000)) {
        chunks.push(`[${chunk.join(",")}]`);
        chunk = [];
        bytes = 2;
      }
      chunk.push(json);
      bytes += size;
    }
    if (chunk.length) chunks.push(`[${chunk.join(",")}]`);
    for (const data of chunks) {
      await this.db
        .prepare(
          `INSERT INTO sync_items (sync_id,connection_id,provider_id,email,label,note,active,provider_created_at,version)
        SELECT ?,?,json_extract(value,'$.providerId'),json_extract(value,'$.email'),json_extract(value,'$.label'),json_extract(value,'$.note'),
        json_extract(value,'$.active'),json_extract(value,'$.createdAt'),json_extract(value,'$.version') FROM json_each(?) WHERE ${this.guard()}`,
        )
        .bind(syncId, row.id, data, ...this.guardValues(row.id))
        .run();
    }
    await this.assertLease(row.id);
    const guard = this.guardValues(row.id);
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO aliases (id,connection_id,provider_id,email,label,note,active,provider_created_at,version,verified_at)
        SELECT lower(hex(randomblob(16))),connection_id,provider_id,email,label,note,active,provider_created_at,version,? FROM sync_items WHERE sync_id = ? AND ${this.guard()}
        ON CONFLICT(connection_id,provider_id) DO UPDATE SET email=excluded.email,label=excluded.label,note=COALESCE(excluded.note,aliases.note),active=excluded.active,
        provider_created_at=COALESCE(excluded.provider_created_at,aliases.provider_created_at),version=excluded.version,verified_at=excluded.verified_at,deleted_at=NULL`,
        )
        .bind(now, syncId, ...guard),
      this.db
        .prepare(
          `UPDATE aliases SET deleted_at = ? WHERE connection_id = ? AND deleted_at IS NULL AND provider_id NOT IN (SELECT provider_id FROM sync_items WHERE sync_id = ?) AND ${this.guard()}`,
        )
        .bind(now, row.id, syncId, ...guard),
      this.db
        .prepare(
          `UPDATE connections SET last_sync = ?, last_error = NULL WHERE id = ? AND ${this.guard()}`,
        )
        .bind(now, row.id, ...guard),
      this.db.prepare("DELETE FROM sync_items WHERE sync_id = ?").bind(syncId),
    ]);
    await this.assertLease(row.id);
  }
  async pending(connectionId: string, except = "") {
    return this.db
      .prepare(
        "SELECT * FROM operations WHERE connection_id = ? AND id != ? AND status IN ('pending','running','needs_verification') LIMIT 1",
      )
      .bind(connectionId, except)
      .first<OperationRow>();
  }
  async operation(id: string) {
    const row = await this.db
      .prepare(
        "SELECT * FROM operations WHERE id = ? AND connection_id IN (SELECT id FROM connections WHERE owner_id = ?)",
      )
      .bind(id, this.owner)
      .first<OperationRow>();
    if (!row)
      throw new AppError("not_found", "This operation was not found.", 404);
    return row;
  }
  async operationKey(connectionId: string, operationKey: string) {
    return this.db
      .prepare(
        "SELECT * FROM operations WHERE connection_id = ? AND operation_key = ?",
      )
      .bind(connectionId, operationKey)
      .first<OperationRow>();
  }
  async addOperation(
    row: ConnectionRow,
    operationKey: string,
    action: string,
    payload: unknown,
    aliasId?: string,
  ) {
    const id = crypto.randomUUID(),
      now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO operations (id,connection_id,operation_key,request_hash,action,alias_id,payload,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE ${this.guard()}`,
      )
      .bind(
        id,
        row.id,
        operationKey,
        await hash([action, aliasId ?? null, payload]),
        action,
        aliasId ?? null,
        JSON.stringify(payload),
        now,
        now,
        ...this.guardValues(row.id),
      )
      .run();
    return this.operation(id);
  }
  async progress(
    op: OperationRow,
    phase: string,
    status = "running",
    error: string | null = null,
    candidate = op.candidate,
    result: unknown = null,
  ) {
    const updated = await this.db
      .prepare(
        `UPDATE operations SET phase = ?, status = ?, error_code = ?, candidate = ?, result = ?, updated_at = ? WHERE id = ? AND ${this.guard()}`,
      )
      .bind(
        phase,
        status,
        error,
        candidate,
        result === null ? null : JSON.stringify(result),
        new Date().toISOString(),
        op.id,
        ...this.guardValues(op.connection_id),
      )
      .run();
    if (!updated.meta.changes)
      throw new AppError(
        "unknown_outcome",
        messageFor("unknown_outcome"),
        409,
        op.id,
      );
    op.phase = phase;
    op.status = status;
    op.candidate = candidate;
    op.error_code = error;
  }
  async maintenance(days = 30) {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    await this.db.batch([
      this.db
        .prepare(
          "DELETE FROM operations WHERE status IN ('succeeded','failed') AND updated_at < ?",
        )
        .bind(cutoff),
      this.db
        .prepare(
          "DELETE FROM aliases WHERE deleted_at < ? AND NOT EXISTS (SELECT 1 FROM operations WHERE alias_id=aliases.id)",
        )
        .bind(cutoff),
      this.db
        .prepare(
          "DELETE FROM sync_items WHERE connection_id IN (SELECT id FROM connections WHERE lease_token IS NULL OR lease_expires < ?)",
        )
        .bind(Date.now()),
    ]);
  }
}
