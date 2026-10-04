import type { Env } from "./types";
import {
  Store,
  publicAlias,
  publicConnection,
  publicOperation,
  metadataVersion,
  type ConnectionRow,
  type OperationRow,
} from "./db";
import { decrypt, encrypt, hash } from "./crypto";
import { CookieJar, importCookies, type Cookie } from "./icloud/cookies";
import { ICloudClient, type RemoteAlias } from "./icloud/client";
import { AppError, messageFor } from "./errors";
import type { Region } from "../shared/types";

export class Services {
  constructor(
    public env: Env,
    public store: Store,
  ) {}
  context(row: ConnectionRow) {
    return `${row.owner_id}:${row.id}:${row.account_id}`;
  }
  async withClient<T>(
    callback: (client: ICloudClient, row: ConnectionRow) => Promise<T>,
  ): Promise<T> {
    const row = await this.store.requireConnection();
    if (row.status === "reconnect_required")
      throw new AppError(
        "reconnect_required",
        messageFor("reconnect_required"),
        401,
      );
    await this.store.acquire(row);
    let client: ICloudClient | undefined,
      status = "connected",
      lastError: string | null = null;
    try {
      const cookies = await decrypt<Cookie[]>(
        this.env.SESSION_ENCRYPTION_KEY,
        row.cookies_cipher,
        this.context(row),
      );
      client = new ICloudClient(
        new CookieJar(cookies),
        row.region,
        row.client_id,
        row.account_id,
        row.service_url,
        () => this.store.assertLease(row.id),
      );
      return await callback(client, row);
    } catch (error) {
      if (error instanceof AppError) {
        lastError = error.code;
        if (error.code === "reconnect_required") status = "reconnect_required";
        if (error.code === "session_unreadable") {
          status = "reconnect_required";
          throw new AppError(
            "reconnect_required",
            messageFor("reconnect_required"),
            401,
          );
        }
      }
      throw error;
    } finally {
      try {
        if (client) {
          const cipher = await encrypt(
            this.env.SESSION_ENCRYPTION_KEY,
            client.jar.cookies,
            this.context(row),
          );
          await this.store.saveSession(row, cipher, status, lastError);
        } else if (status === "reconnect_required") {
          await this.store.saveSession(
            row,
            row.cookies_cipher,
            status,
            lastError,
          );
        }
      } finally {
        await this.store.release(row.id);
      }
    }
  }
  async connect(cookieInput: string, region: Region) {
    const previous = await this.store.connection();
    if (previous) await this.store.acquire(previous);
    let saved: ConnectionRow | undefined;
    try {
      const client = new ICloudClient(
        new CookieJar(importCookies(cookieInput, region)),
        region,
        crypto.randomUUID(),
        "",
        "",
        previous ? () => this.store.assertLease(previous.id) : undefined,
      );
      const account = await client.validate();
      if (previous && previous.account_id !== account.id)
        throw new AppError(
          "account_mismatch",
          "Sign in with the Apple account already connected to this app.",
          409,
        );
      const aliases = await client.list();
      const now = new Date().toISOString(),
        id = previous?.id ?? crypto.randomUUID();
      const cipher = await encrypt(
        this.env.SESSION_ENCRYPTION_KEY,
        client.jar.cookies,
        `${this.store.owner}:${id}:${account.id}`,
      );
      if (previous) {
        const result = await this.env.DB.prepare(
          `UPDATE connections SET account_email=?,region=?,cookies_cipher=?,service_url=?,client_id=?,status='connected',session_version=session_version+1,last_error=NULL,updated_at=? WHERE id=? AND ${this.store.guard()}`,
        )
          .bind(
            account.email,
            region,
            cipher,
            account.serviceUrl,
            client.clientId,
            now,
            id,
            ...this.store.guardValues(id),
          )
          .run();
        if (!result.meta.changes)
          throw new AppError("busy", messageFor("busy"), 409);
      } else {
        this.store.leaseToken = crypto.randomUUID();
        await this.env.DB.prepare(
          `INSERT INTO connections (id,owner_id,account_id,account_email,region,cookies_cipher,service_url,client_id,lease_token,lease_expires,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
          .bind(
            id,
            this.store.owner,
            account.id,
            account.email,
            region,
            cipher,
            account.serviceUrl,
            client.clientId,
            this.store.leaseToken,
            Date.now() + 180_000,
            now,
            now,
          )
          .run();
      }
      saved = (await this.store.connection())!;
      await this.store.sync(saved, aliases);
      return publicConnection(await this.store.connection());
    } finally {
      if (saved || previous) await this.store.release((saved ?? previous)!.id);
    }
  }
  async refresh(automatic = false) {
    const current = await this.store.requireConnection();
    // Multiple tabs and cron can share a recent successful refresh.
    if (
      automatic &&
      current.status === "connected" &&
      current.last_sync &&
      Date.now() - Date.parse(current.last_sync) < 60_000
    )
      return this.store.snapshot();
    return this.withClient(async (client, row) => {
      // Validate the saved session and accept Apple's Set-Cookie rotation.
      // Never invent a longer lifetime or reuse a different Apple account.
      const account = await client.validate();
      if (account.id !== row.account_id)
        throw new AppError(
          "reconnect_required",
          "Sign in with the Apple account already connected to this app.",
          401,
        );
      await this.store.saveService(row, account.serviceUrl);
      await this.store.sync(row, await client.list());
      return this.store.snapshot();
    });
  }
  async detail(id: string) {
    const cached = await this.store.alias(id);
    return this.withClient(async (client, row) => {
      const remote = await client.detail(cached.provider_id);
      const saved = publicAlias(await this.store.upsert(row.id, remote));
      // A cached note is useful in search, but cannot authorize an edit when Apple omits it.
      return { ...saved, note: remote.note };
    });
  }
  async verified(
    client: ICloudClient,
    alias: RemoteAlias,
    label?: string,
    note?: string,
  ): Promise<RemoteAlias> {
    let result = alias;
    if (result.note === null) result = await client.detail(alias.providerId);
    if (
      (label !== undefined && result.label !== label) ||
      (note !== undefined && result.note !== note)
    ) {
      throw new AppError("unknown_outcome", messageFor("unknown_outcome"), 409);
    }
    return result;
  }
  async mutate(
    action: string,
    operationKey: string,
    payload: Record<string, unknown>,
    aliasId?: string,
  ) {
    const row = await this.store.requireConnection();
    const requestHash = await hash([action, aliasId ?? null, payload]);
    const existing = await this.store.operationKey(row.id, operationKey);
    if (existing) {
      if (existing.request_hash !== requestHash)
        throw new AppError(
          "conflict",
          "This operation key was already used for a different request.",
          409,
        );
      return {
        operation: publicOperation(existing),
        snapshot: await this.store.snapshot(),
      };
    }
    return this.withClient(async (client, connection) => {
      const recorded = await this.store.operationKey(
        connection.id,
        operationKey,
      );
      if (recorded) {
        if (recorded.request_hash !== requestHash)
          throw new AppError(
            "conflict",
            "This operation key was already used for a different request.",
            409,
          );
        return {
          operation: publicOperation(recorded),
          snapshot: await this.store.snapshot(),
        };
      }
      const pending = await this.store.pending(connection.id);
      if (pending)
        throw new AppError(
          "unknown_outcome",
          "Check the unfinished operation before making another change.",
          409,
          pending.id,
        );
      const cached = aliasId ? await this.store.alias(aliasId) : undefined;
      const op = await this.store.addOperation(
        connection,
        operationKey,
        action,
        payload,
        aliasId,
      );
      let writeStarted = false;
      try {
        let result: RemoteAlias | undefined;
        await this.store.progress(op, "checking");
        if (action === "create") {
          await this.store.progress(op, "generating");
          const candidate = await client.generate();
          await this.store.progress(
            op,
            "candidate",
            "running",
            null,
            candidate,
          );
          await this.store.progress(op, "reserve_sent");
          writeStarted = true;
          await client.reserve(
            candidate,
            payload.label as string,
            payload.note as string,
          );
          result = (await client.list()).find((x) => x.email === candidate);
          if (!result)
            throw new AppError(
              "unknown_outcome",
              messageFor("unknown_outcome"),
              409,
            );
          result = await this.verified(
            client,
            result,
            payload.label as string,
            payload.note as string,
          );
        } else {
          if (!cached)
            throw new AppError("not_found", "Address not found.", 404);
          let current = await client.detail(cached.provider_id);
          await this.store.upsert(connection.id, current);
          if (action === "edit") {
            if (current.note === null)
              throw new AppError(
                "malformed_response",
                "iCloud did not return this note. Reopen the address to try again.",
                502,
              );
            if ((await metadataVersion(current)) !== payload.baseVersion)
              throw new AppError("conflict", messageFor("conflict"), 409);
            const label =
              typeof payload.label === "string" ? payload.label : current.label;
            const note =
              typeof payload.note === "string" ? payload.note : current.note;
            op.payload = JSON.stringify({ ...payload, label, note });
            await this.env.DB.prepare(
              `UPDATE operations SET payload=? WHERE id=? AND ${this.store.guard()}`,
            )
              .bind(op.payload, op.id, ...this.store.guardValues(connection.id))
              .run();
            await this.store.progress(op, "update_sent");
            writeStarted = true;
            await client.metadata(current.providerId, label, note);
            result = await this.verified(
              client,
              await client.detail(current.providerId),
              label,
              note,
            );
          } else if (action === "delete") {
            if (current.active) {
              await this.store.progress(op, "deactivate_sent");
              writeStarted = true;
              await client.action("deactivate", current.providerId);
              current = await client.detail(current.providerId);
              await this.store.upsert(connection.id, current);
              if (current.active)
                throw new AppError(
                  "unknown_outcome",
                  messageFor("unknown_outcome"),
                  409,
                );
            }
            await this.store.progress(op, "delete_sent");
            writeStarted = true;
            await client.action("delete", current.providerId);
            const aliases = await client.list();
            if (aliases.some((x) => x.providerId === current.providerId))
              throw new AppError(
                "unknown_outcome",
                messageFor("unknown_outcome"),
                409,
              );
            await this.store.sync(connection, aliases);
          } else {
            const active = action === "reactivate";
            if (current.active !== active) {
              await this.store.progress(op, `${action}_sent`);
              writeStarted = true;
              await client.action(
                active ? "reactivate" : "deactivate",
                current.providerId,
              );
            }
            result = await client.detail(current.providerId);
            if (result.active !== active)
              throw new AppError(
                "unknown_outcome",
                messageFor("unknown_outcome"),
                409,
              );
          }
        }
        const saved = result
          ? publicAlias(await this.store.upsert(connection.id, result))
          : null;
        await this.store.progress(
          op,
          "verified",
          "succeeded",
          null,
          op.candidate,
          saved,
        );
        return {
          operation: publicOperation(op),
          snapshot: await this.store.snapshot(),
        };
      } catch (error) {
        const safe =
          error instanceof AppError
            ? error
            : new AppError(
                "internal_error",
                "The operation could not be completed.",
                500,
              );
        await this.store.progress(
          op,
          op.phase,
          writeStarted ? "needs_verification" : "failed",
          safe.code,
        );
        safe.operationId = op.id;
        throw safe;
      }
    });
  }
  async reconcile(id: string) {
    const op = await this.store.operation(id);
    if (["succeeded", "failed"].includes(op.status))
      return {
        operation: publicOperation(op),
        snapshot: await this.store.snapshot(),
      };
    return this.withClient(async (client, connection) => {
      const aliases = await client.list();
      const payload = JSON.parse(op.payload) as Record<string, unknown>;
      let alias: RemoteAlias | undefined;
      let success = false;
      if (op.action === "create") {
        alias = aliases.find((x) => x.email === op.candidate);
        if (alias) {
          alias = await this.verified(
            client,
            alias,
            payload.label as string,
            payload.note as string,
          );
          success = true;
        }
      } else {
        const target = op.alias_id
          ? await this.env.DB.prepare(
              "SELECT * FROM aliases WHERE id=? AND connection_id=?",
            )
              .bind(op.alias_id, connection.id)
              .first<{ provider_id: string }>()
          : null;
        alias = aliases.find((x) => x.providerId === target?.provider_id);
        if (op.action === "delete") success = Boolean(target) && !alias;
        else if (alias && op.action === "edit") {
          if (alias.note === null)
            alias = await client.detail(alias.providerId);
          success =
            alias.label === payload.label && alias.note === payload.note;
        } else if (alias)
          success = alias.active === (op.action === "reactivate");
      }
      await this.store.sync(connection, aliases);
      if (alias) await this.store.upsert(connection.id, alias);
      await this.store.progress(
        op,
        success ? "verified" : "checked",
        success ? "succeeded" : "failed",
        success ? null : "not_applied",
      );
      return {
        operation: publicOperation(op),
        snapshot: await this.store.snapshot(),
      };
    });
  }
}
