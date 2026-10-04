import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  reset,
  createExecutionContext,
} from "cloudflare:test";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPair, SignJWT, exportJWK } from "jose";
import app from "../../src/worker/index";
import { Store } from "../../src/worker/db";
import { encrypt, decrypt } from "../../src/worker/crypto";
import {
  CookieJar,
  importCookies,
  appleUrl,
} from "../../src/worker/icloud/cookies";
import { parseList, type RemoteAlias } from "../../src/worker/icloud/client";
import type { Snapshot } from "../../src/shared/types";
import type { Env } from "../../src/worker/types";

interface AppleAlias {
  anonymousId: string;
  hme: string;
  label: string;
  note?: string;
  isActive: boolean;
  createTimestamp?: number;
}
let aliases: AppleAlias[],
  calls: { path: string; body: Record<string, unknown> }[];
let failure: string, loseReserve: boolean, accountId: string;
const origin = "http://localhost";
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  bindings: Env = env,
  extra: Record<string, string> = {},
) {
  return app.fetch(
    new Request(`${origin}/api${path}`, {
      method,
      headers: { Origin: origin, "Content-Type": "application/json", ...extra },
      ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
    }),
    bindings,
    createExecutionContext(),
  );
}
const key = () => crypto.randomUUID();
async function connect() {
  const response = await request("/icloud/connection", "PUT", {
    cookies: "session=private-session-token",
    region: "global",
  });
  expect(response.status).toBe(200);
}
async function snapshot() {
  return (await (await request("/aliases")).json()) as Snapshot;
}
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  aliases = [
    {
      anonymousId: "apple-1",
      hme: "existing@icloud.com",
      label: "Shopping",
      note: "Original note",
      isActive: true,
    },
  ];
  calls = [];
  failure = "";
  loseReserve = false;
  accountId = "123";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      if (!url.hostname.endsWith("icloud.com"))
        throw new Error("Unexpected outgoing request");
      const path = url.pathname.split("/").at(-1)!;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      calls.push({ path, body });
      if (failure === "auth") return new Response("{}", { status: 421 });
      if (failure === path)
        return Response.json({
          success: false,
          error: { errorMessage: "provider private diagnostic" },
        });
      if (path === "validate")
        return Response.json(
          {
            dsInfo: { dsid: accountId, appleId: "owner@example.com" },
            webservices: {
              premiummailsettings: {
                url: "https://p01-maildomainws.icloud.com",
              },
            },
          },
          {
            headers: {
              "Set-Cookie":
                "rotated=secret-rotated-value; Domain=.icloud.com; Path=/; Secure; HttpOnly",
            },
          },
        );
      if (path === "list")
        return Response.json({
          success: true,
          result: failure === "malformed" ? {} : { hmeEmails: aliases },
        });
      if (path === "get")
        return Response.json({
          success: true,
          result: {
            hmeEmail: aliases.find((x) => x.anonymousId === body.anonymousId),
          },
        });
      if (path === "generate")
        return Response.json({
          success: true,
          result: { hme: "new-random@icloud.com" },
        });
      if (path === "reserve") {
        aliases.push({
          anonymousId: "apple-2",
          hme: body.hme as string,
          label: body.label as string,
          note: body.note as string,
          isActive: true,
          createTimestamp: Date.now(),
        });
        if (loseReserve)
          throw new Error("Connection lost after Apple applied the request");
      } else if (path === "updateMetaData")
        Object.assign(
          aliases.find((x) => x.anonymousId === body.anonymousId)!,
          { label: body.label, note: body.note },
        );
      else if (path === "deactivate" || path === "reactivate")
        aliases.find((x) => x.anonymousId === body.anonymousId)!.isActive =
          path === "reactivate";
      else if (path === "delete")
        aliases = aliases.filter((x) => x.anonymousId !== body.anonymousId);
      else throw new Error("Unexpected Apple endpoint");
      return Response.json({ success: true, result: {} });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("iCloud operations with real Worker crypto and D1", () => {
  it("sorts newest first across statuses and keeps that order after edits and creation", async () => {
    aliases = [
      {
        anonymousId: "apple-older",
        hme: "older@icloud.com",
        label: "A older address",
        note: "Older note",
        isActive: true,
        createTimestamp: Date.UTC(2024, 0, 1),
      },
      {
        anonymousId: "apple-newest",
        hme: "newest@icloud.com",
        label: "Z newest address",
        note: "Newer note",
        isActive: false,
        createTimestamp: Date.UTC(2025, 0, 1) / 1000,
      },
      {
        anonymousId: "apple-unknown",
        hme: "unknown@icloud.com",
        label: "A unknown creation date",
        note: "",
        isActive: true,
      },
    ];
    await connect();
    const ordered = await snapshot();
    expect(ordered.aliases.map((alias) => alias.email)).toEqual([
      "newest@icloud.com",
      "older@icloud.com",
      "unknown@icloud.com",
    ]);
    const older = ordered.aliases[1];
    expect(
      (
        await request(`/aliases/${older.id}`, "PATCH", {
          operationKey: key(),
          baseVersion: older.version,
          label: "Recently edited",
        })
      ).status,
    ).toBe(200);
    expect((await snapshot()).aliases.map((alias) => alias.email)).toEqual(
      ordered.aliases.map((alias) => alias.email),
    );
    const created = await request("/aliases", "POST", {
      operationKey: key(),
      label: "New address",
      note: "",
    });
    expect(created.status).toBe(201);
    expect(
      ((await created.json()) as { snapshot: Snapshot }).snapshot.aliases[0]
        .email,
    ).toBe("new-random@icloud.com");
    expect((await snapshot()).aliases[0].email).toBe("new-random@icloud.com");
  });
  it("creates, edits Unicode notes, clears notes, toggles and permanently deletes at the provider", async () => {
    await connect();
    const operationKey = key();
    const createBody = { operationKey, label: "Travel", note: "京都 ✉️" };
    expect((await request("/aliases", "POST", createBody)).status).toBe(201);
    expect((await request("/aliases", "POST", createBody)).status).toBe(201);
    expect(calls.filter((x) => x.path === "reserve")).toHaveLength(1);
    let alias = (await snapshot()).aliases.find(
      (x) => x.email === "new-random@icloud.com",
    )!;
    expect(alias.note).toBe("京都 ✉️");
    let response = await request(`/aliases/${alias.id}`, "PATCH", {
      operationKey: key(),
      baseVersion: alias.version,
      note: "Notes 🧡\n第二行",
    });
    expect(response.status).toBe(200);
    expect(aliases[1].label).toBe("Travel");
    alias = (await snapshot()).aliases.find((x) => x.id === alias.id)!;
    expect(
      (
        await request(`/aliases/${alias.id}`, "PATCH", {
          operationKey: key(),
          baseVersion: alias.version,
          note: "",
        })
      ).status,
    ).toBe(200);
    expect(aliases[1].note).toBe("");
    expect(
      (
        await request(`/aliases/${alias.id}/deactivate`, "POST", {
          operationKey: key(),
        })
      ).status,
    ).toBe(200);
    expect(aliases[1].isActive).toBe(false);
    expect(
      (
        await request(`/aliases/${alias.id}/reactivate`, "POST", {
          operationKey: key(),
        })
      ).status,
    ).toBe(200);
    const deleteKey = key(),
      deleteBody = { operationKey: deleteKey, confirmEmail: alias.email };
    expect(
      (await request(`/aliases/${alias.id}`, "DELETE", deleteBody)).status,
    ).toBe(200);
    expect(
      (await request(`/aliases/${alias.id}`, "DELETE", deleteBody)).status,
    ).toBe(200);
    expect(calls.filter((x) => x.path === "delete")).toHaveLength(1);
    expect(aliases).toHaveLength(1);
    expect((await snapshot()).aliases).toHaveLength(1);
    const phases = calls
      .filter((x) => ["deactivate", "delete"].includes(x.path))
      .map((x) => x.path);
    expect(phases.slice(-2)).toEqual(["deactivate", "delete"]);
  });
  it("reconciles a lost reserve response without reserving another address", async () => {
    await connect();
    loseReserve = true;
    const response = await request("/aliases", "POST", {
      operationKey: key(),
      label: "Lost response",
      note: "saved",
    });
    expect(response.status).toBe(504);
    const data = await snapshot();
    expect(data.operations[0].status).toBe("needs_verification");
    expect(
      (
        await request("/aliases", "POST", {
          operationKey: key(),
          label: "Blocked",
          note: "",
        })
      ).status,
    ).toBe(409);
    const result = await request(
      `/operations/${data.operations[0].id}/reconcile`,
      "POST",
    );
    expect(result.status).toBe(200);
    expect((await snapshot()).operations).toHaveLength(0);
    expect((await snapshot()).aliases).toHaveLength(2);
    expect(calls.filter((x) => x.path === "reserve")).toHaveLength(1);
  });
  it("retains cached aliases on HTTP 200 failure and malformed list responses", async () => {
    await connect();
    for (const mode of ["list", "malformed"]) {
      failure = mode;
      const response = await request("/aliases/sync", "POST");
      expect(response.status).toBe(502);
      expect((await snapshot()).aliases).toHaveLength(1);
      expect(await response.text()).not.toContain("private diagnostic");
    }
  });
  it("marks an expired session and keeps the cached aliases readable", async () => {
    await connect();
    failure = "auth";
    expect((await request("/aliases/sync", "POST")).status).toBe(401);
    const data = await snapshot();
    expect(data.connection?.status).toBe("reconnect_required");
    expect(data.aliases).toHaveLength(1);
  });
  it("rejects an invalid replacement and a different account while retaining the original session", async () => {
    await connect();
    const store = new Store(env.DB, "owner"),
      original = await store.connection();
    failure = "auth";
    expect(
      (
        await request("/icloud/connection", "PUT", {
          cookies: "bad=token",
          region: "global",
        })
      ).status,
    ).toBe(401);
    expect((await store.connection())?.cookies_cipher).toBe(
      original?.cookies_cipher,
    );
    failure = "";
    accountId = "different";
    expect(
      (
        await request("/icloud/connection", "PUT", {
          cookies: "other=token",
          region: "global",
        })
      ).status,
    ).toBe(409);
    expect((await store.connection())?.account_id).toBe("123");
    expect((await snapshot()).aliases).toHaveLength(1);
  });
  it("recovers an unreadable saved session through the same-account wizard", async () => {
    await connect();
    await env.DB.prepare("UPDATE connections SET cookies_cipher = ?")
      .bind("corrupt")
      .run();
    expect((await request("/aliases/sync", "POST")).status).toBe(401);
    expect((await snapshot()).connection?.status).toBe("reconnect_required");
    expect((await snapshot()).aliases).toHaveLength(1);
    await connect();
    expect((await snapshot()).connection?.status).toBe("connected");
  });
  it("rejects stale note edits and preserves the external change", async () => {
    await connect();
    const alias = (await snapshot()).aliases[0];
    aliases[0].note = "Changed in Apple Settings";
    expect(
      (
        await request(`/aliases/${alias.id}`, "PATCH", {
          operationKey: key(),
          baseVersion: alias.version,
          note: "Overwrite",
        })
      ).status,
    ).toBe(409);
    expect(calls.filter((x) => x.path === "updateMetaData")).toHaveLength(0);
    expect((await snapshot()).aliases[0].note).toBe(
      "Changed in Apple Settings",
    );
  });
  it("does not edit when Apple omits the current note", async () => {
    await connect();
    const alias = (await snapshot()).aliases[0];
    delete aliases[0].note;
    const detail = (await (await request(`/aliases/${alias.id}`)).json()) as {
      alias: { note: string | null };
    };
    expect(detail.alias.note).toBeNull();
    expect(
      (
        await request(`/aliases/${alias.id}`, "PATCH", {
          operationKey: key(),
          baseVersion: alias.version,
          note: "",
        })
      ).status,
    ).toBe(502);
    expect(calls.filter((x) => x.path === "updateMetaData")).toHaveLength(0);
    expect((await snapshot()).aliases[0].note).toBe("Original note");
  });
  it("shows an inactive address if permanent deletion fails after deactivation", async () => {
    await connect();
    const alias = (await snapshot()).aliases[0];
    failure = "delete";
    expect(
      (
        await request(`/aliases/${alias.id}`, "DELETE", {
          operationKey: key(),
          confirmEmail: alias.email,
        })
      ).status,
    ).toBe(502);
    const data = await snapshot();
    expect(data.aliases[0].active).toBe(false);
    expect(data.operations[0].status).toBe("needs_verification");
    expect(
      (await request(`/operations/${data.operations[0].id}/reconcile`, "POST"))
        .status,
    ).toBe(200);
    expect((await snapshot()).aliases[0].active).toBe(false);
  });
  it("encrypts rotated sessions and excludes cookies from API responses and exports", async () => {
    await connect();
    const row = (await new Store(env.DB, "owner").connection())!;
    expect(row.cookies_cipher).not.toContain("private-session-token");
    const cookies = await decrypt<{ value: string }[]>(
      env.SESSION_ENCRYPTION_KEY,
      row.cookies_cipher,
      `owner:${row.id}:123`,
    );
    expect(cookies.some((x) => x.value === "secret-rotated-value")).toBe(true);
    for (const path of ["/aliases", "/icloud/connection", "/aliases/export"]) {
      const text = await (await request(path)).text();
      expect(text).not.toMatch(
        /private-session-token|secret-rotated-value|cookies_cipher/,
      );
    }
    await expect(
      decrypt(env.SESSION_ENCRYPTION_KEY, row.cookies_cipher, "wrong-owner"),
    ).rejects.toMatchObject({ code: "session_unreadable" });
  });
  it("fences concurrent requests and stale lease writers", async () => {
    await connect();
    const store = new Store(env.DB, "owner"),
      row = (await store.connection())!;
    await store.acquire(row);
    expect((await request("/aliases/sync", "POST")).status).toBe(409);
    await env.DB.prepare("UPDATE connections SET lease_token=? WHERE id=?")
      .bind("new-owner-token", row.id)
      .run();
    await expect(store.saveSession(row, "stale cipher")).rejects.toMatchObject({
      code: "unknown_outcome",
    });
    await store.release(row.id);
    expect((await store.connection())?.lease_token).toBe("new-owner-token");
  });
  it("accepts a verified empty list and keeps the app bound to one Apple account", async () => {
    await connect();
    aliases = [];
    expect((await request("/aliases/sync", "POST")).status).toBe(200);
    expect((await snapshot()).aliases).toHaveLength(0);
    expect((await request("/icloud/connection", "DELETE")).status).toBe(404);
    expect((await snapshot()).connection).not.toBeNull();
    expect(calls.some((x) => x.path === "delete")).toBe(false);
  });
  it("refreshes automatically in the background and persists renewed cookies", async () => {
    await connect();
    await env.DB.prepare("UPDATE connections SET last_sync = ?")
      .bind("2000-01-01T00:00:00Z")
      .run();
    aliases[0].note = "Updated while the app was closed";
    const row = (await new Store(env.DB, "owner").connection())!;
    const original = row.cookies_cipher;
    calls = [];
    await app.scheduled(
      { scheduledTime: Date.UTC(2026, 9, 4, 10, 17) } as ScheduledController,
      env,
    );
    const fresh = (await new Store(env.DB, "owner").connection())!;
    expect(calls.map((call) => call.path)).toEqual(["validate", "list"]);
    expect(fresh.cookies_cipher).not.toBe(original);
    const cookies = await decrypt<{ value: string }[]>(
      env.SESSION_ENCRYPTION_KEY,
      fresh.cookies_cipher,
      `owner:${row.id}:123`,
    );
    expect(
      cookies.some((cookie) => cookie.value === "secret-rotated-value"),
    ).toBe(true);
    expect((await snapshot()).aliases[0].note).toBe(
      "Updated while the app was closed",
    );
    expect(fresh.lease_token).toBeNull();
  });
  it("coalesces automatic refreshes and stops background requests after session expiry", async () => {
    await connect();
    calls = [];
    expect(
      (await request("/aliases/sync", "POST", { automatic: true })).status,
    ).toBe(200);
    expect(calls).toHaveLength(0);
    await env.DB.prepare("UPDATE connections SET last_sync = NULL").run();
    failure = "auth";
    await app.scheduled(
      { scheduledTime: Date.UTC(2026, 9, 4, 10, 17) } as ScheduledController,
      env,
    );
    expect((await snapshot()).connection?.status).toBe("reconnect_required");
    expect((await snapshot()).aliases).toHaveLength(1);
    calls = [];
    await app.scheduled(
      { scheduledTime: Date.UTC(2026, 9, 4, 11, 17) } as ScheduledController,
      env,
    );
    expect(calls).toHaveLength(0);
  });
  it("rejects an account change during validation before reading another account's addresses", async () => {
    await connect();
    accountId = "another-account";
    calls = [];
    expect((await request("/aliases/sync", "POST")).status).toBe(401);
    expect(calls.map((call) => call.path)).toEqual(["validate"]);
    expect((await snapshot()).connection?.status).toBe("reconnect_required");
    expect((await new Store(env.DB, "owner").connection())?.account_id).toBe(
      "123",
    );
    expect((await snapshot()).aliases[0].email).toBe("existing@icloud.com");
  });
  it("normalizes exported expiry units and drops expired cookies without extending their life", () => {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const cookies = importCookies(
      JSON.stringify([
        { name: "live", value: "token", domain: ".icloud.com", expires },
        { name: "expired", value: "old", domain: ".icloud.com", expires: 1 },
        { name: "epoch", value: "expired", domain: ".icloud.com", expires: 0 },
        {
          name: "session",
          value: "session",
          domain: ".icloud.com",
          expires: -1,
        },
      ]),
      "global",
    );
    const jar = new CookieJar(cookies);
    expect(jar.cookies.map((cookie) => cookie.name)).toEqual([
      "live",
      "session",
    ]);
    expect(jar.cookies[0].expires).toBe(expires * 1000);
    jar.update(
      new URL("https://setup.icloud.com/"),
      new Headers({
        "Set-Cookie":
          "live=expired; Domain=.icloud.com; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
      }),
    );
    expect(jar.cookies.map((cookie) => cookie.name)).toEqual(["session"]);
  });
  it("keeps the visible snapshot when a staged sync loses its lease, then recovers on the next sync", async () => {
    await connect();
    const store = new Store(env.DB, "owner"),
      row = (await store.connection())!;
    await store.acquire(row);
    const incoming: RemoteAlias[] = Array.from({ length: 250 }, (_, i) => ({
      providerId: `bulk-${i}`,
      email: `bulk-${i}@icloud.com`,
      label: "Bulk alias",
      note: "",
      active: true,
      createdAt: null,
    }));
    const assert = vi
      .spyOn(store, "assertLease")
      .mockRejectedValueOnce(new Error("Lease expired before publication"));
    await expect(store.sync(row, incoming)).rejects.toThrow("Lease expired");
    expect((await snapshot()).aliases).toHaveLength(1);
    assert.mockRestore();
    await store.sync(row, incoming);
    expect((await snapshot()).aliases).toHaveLength(250);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS total FROM sync_items").first<{
          total: number;
        }>()
      )?.total,
    ).toBe(0);
    await store.release(row.id);
  });
  it("publishes 750 aliases in bounded batches and preserves long Unicode notes", async () => {
    await connect();
    const store = new Store(env.DB, "owner"),
      row = (await store.connection())!;
    await store.acquire(row);
    const note = "🧡".repeat(10_000);
    const incoming: RemoteAlias[] = Array.from({ length: 750 }, (_, i) => ({
      providerId: `large-${i}`,
      email: `large-${i}@icloud.com`,
      label: `Alias ${i}`,
      note: i < 105 ? note : "",
      active: true,
      createdAt: null,
    }));
    await store.sync(row, incoming);
    const data = await snapshot();
    expect(data.aliases).toHaveLength(750);
    expect(
      data.aliases.find((x) => x.email === "large-104@icloud.com")?.note,
    ).toBe(note);
    await store.release(row.id);
  });
  it("ages out terminal receipts while preserving unresolved operations", async () => {
    await connect();
    await request("/aliases", "POST", {
      operationKey: key(),
      label: "Receipt",
      note: "",
    });
    loseReserve = true;
    await request("/aliases", "POST", {
      operationKey: key(),
      label: "Unresolved",
      note: "",
    });
    await env.DB.prepare("UPDATE operations SET updated_at=?")
      .bind("2000-01-01T00:00:00Z")
      .run();
    await new Store(env.DB, "owner").maintenance(30);
    const rows = await env.DB.prepare("SELECT status FROM operations").all<{
      status: string;
    }>();
    expect(rows.results.map((x) => x.status)).toEqual(["needs_verification"]);
  });
});

describe("authentication and input boundaries", () => {
  it("does not allow development authentication on a remote hostname or production binding", async () => {
    expect(
      (
        await app.fetch(
          new Request("https://example.workers.dev/api/aliases"),
          env,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await request("/aliases", "GET", undefined, {
          ...env,
          APP_ENV: "production",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request("/aliases/sync", "POST", {}, env, {
          Origin: "https://evil.example",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/aliases", "POST", {}, env, {
          "Content-Type": "text/plain",
        })
      ).status,
    ).toBe(415);
  });
  it("verifies signed Access JWTs, rejects wrong audience, expired and unlisted identities", async () => {
    vi.unstubAllGlobals();
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "test-key";
    jwk.alg = "RS256";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ keys: [jwk] })),
    );
    const team = "hme-test.cloudflareaccess.com";
    const bindings = {
      ...env,
      APP_ENV: "production",
      ACCESS_TEAM_DOMAIN: team,
      ACCESS_AUD: "expected-aud",
      ALLOWED_EMAILS: "owner@example.com",
    };
    const token = (
      email = "owner@example.com",
      aud = "expected-aud",
      exp: string | number = "5m",
    ) =>
      new SignJWT({ email })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(`https://${team}`)
        .setSubject("user")
        .setAudience(aud)
        .setExpirationTime(exp)
        .sign(privateKey);
    expect(
      (
        await request("/aliases", "GET", undefined, bindings, {
          "Cf-Access-Jwt-Assertion": await token(),
        })
      ).status,
    ).toBe(200);
    for (const value of [
      await token("owner@example.com", "wrong-aud"),
      await token("stranger@example.com"),
      await token("owner@example.com", "expected-aud", 1),
      "invalid",
    ]) {
      expect(
        (
          await request("/aliases", "GET", undefined, bindings, {
            "Cf-Access-Jwt-Assertion": value,
          })
        ).status,
      ).toBe(401);
    }
  });
  it("validates provider hosts, cookie scope and Set-Cookie expiry without splitting commas", () => {
    for (const url of [
      "https://icloud.com.evil.example",
      "http://icloud.com",
      "https://user:pass@icloud.com",
      "https://icloud.com:444",
    ])
      expect(() => appleUrl(url)).toThrow();
    const jar = new CookieJar(importCookies("a=one; b=two", "global"));
    const headers = new Headers();
    headers.append(
      "Set-Cookie",
      "a=rotated; Domain=.icloud.com; Path=/; Expires=Thu, 01 Jan 2099 00:00:00 GMT",
    );
    headers.append(
      "Set-Cookie",
      "b=deleted; Domain=.icloud.com; Path=/; Max-Age=0",
    );
    jar.update(new URL("https://setup.icloud.com/"), headers);
    expect(
      jar.header(new URL("https://p01-maildomainws.icloud.com/v2/hme/list")),
    ).toBe("a=rotated");
    expect(jar.header(new URL("https://evil.example"))).toBe("");
    expect(() => importCookies("bad=name\nsecret", "global")).toThrow();
  });
  it("rejects duplicate or incomplete aliases rather than wiping a cache", () => {
    const alias = {
      anonymousId: "same",
      hme: "x@icloud.com",
      isActive: true,
      label: "",
      note: "",
    };
    expect(() => parseList({ hmeEmails: [alias, alias] })).toThrow();
    expect(() => parseList({ hmeEmails: [{ hme: "x@icloud.com" }] })).toThrow();
    expect(parseList({ hmeEmails: [] })).toEqual([]);
  });
  it("binds encryption to the connection and validates key length", async () => {
    const ciphertext = await encrypt(
      env.SESSION_ENCRYPTION_KEY,
      { value: "secret" },
      "context",
    );
    await expect(
      decrypt(env.SESSION_ENCRYPTION_KEY, ciphertext, "other"),
    ).rejects.toMatchObject({ code: "session_unreadable" });
    await expect(encrypt("AAAA", {}, "context")).rejects.toMatchObject({
      code: "setup_required",
    });
  });
});
