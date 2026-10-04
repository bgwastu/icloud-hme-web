import type { Region } from "../../shared/types";
import { AppError, messageFor } from "../errors";
import { appleUrl, CookieJar, rootHost } from "./cookies";

export interface RemoteAlias {
  providerId: string;
  email: string;
  label: string;
  note: string | null;
  active: boolean;
  createdAt: string | null;
}
export interface Account {
  id: string;
  email: string;
  serviceUrl: string;
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const malformed = () =>
  new AppError("malformed_response", messageFor("malformed_response"), 502);
const text = (value: unknown) => (typeof value === "string" ? value : "");
export function parseAlias(value: unknown): RemoteAlias {
  const row = record(value),
    metadata = record(row.metaData);
  const providerId = text(row.anonymousId);
  const email = text(row.hme || row.email).toLowerCase();
  const active =
    typeof row.isActive === "boolean"
      ? row.isActive
      : typeof row.active === "boolean"
        ? row.active
        : row.state === "active"
          ? true
          : row.state === "inactive"
            ? false
            : undefined;
  if (!providerId || !/^[^\s@]+@[^\s@]+$/.test(email) || active === undefined)
    throw malformed();
  const rawLabel = row.label ?? metadata.label;
  if (typeof rawLabel !== "string") throw malformed();
  const note =
    typeof row.note === "string"
      ? row.note
      : typeof metadata.note === "string"
        ? metadata.note
        : null;
  const timestamp = row.createTimestamp ?? row.createdAt;
  let createdAt: string | null = null;
  if (
    typeof timestamp === "number" &&
    Number.isFinite(timestamp) &&
    timestamp > 0
  ) {
    const date = new Date(timestamp > 1e12 ? timestamp : timestamp * 1000);
    if (!Number.isNaN(date.getTime())) createdAt = date.toISOString();
  } else if (
    typeof timestamp === "string" &&
    !Number.isNaN(Date.parse(timestamp))
  )
    createdAt = new Date(timestamp).toISOString();
  return { providerId, email, label: rawLabel, note, active, createdAt };
}
export function parseList(result: unknown): RemoteAlias[] {
  const rows = record(result).hmeEmails;
  if (!Array.isArray(rows)) throw malformed();
  const aliases = rows.map(parseAlias);
  if (new Set(aliases.map((x) => x.providerId)).size !== aliases.length)
    throw malformed();
  return aliases;
}

export class ICloudClient {
  constructor(
    public jar: CookieJar,
    public region: Region,
    public clientId: string,
    public accountId = "",
    public serviceUrl = "",
    private beforeCall?: () => Promise<void>,
  ) {}
  private async request(
    path: string,
    method: string,
    body?: unknown,
    setup = false,
  ): Promise<unknown> {
    await this.beforeCall?.();
    const url = appleUrl(
      setup
        ? `https://setup.${rootHost(this.region)}/setup/ws/1/validate`
        : `${this.serviceUrl}${path}`,
    );
    url.searchParams.set("clientBuildNumber", "2630Build35");
    url.searchParams.set("clientMasteringNumber", "2630Build35");
    url.searchParams.set("clientId", this.clientId);
    if (this.accountId) url.searchParams.set("dsid", this.accountId);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
        headers: {
          Accept: "application/json, text/plain, */*",
          "Content-Type": setup
            ? "application/json"
            : "text/plain;charset=UTF-8",
          Cookie: this.jar.header(url),
          Origin: `https://www.${rootHost(this.region)}`,
          Referer: `https://www.${rootHost(this.region)}/`,
          "User-Agent":
            "Mozilla/5.0 AppleWebKit/537.36 Chrome/147.0.0.0 Safari/537.36",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new AppError("network_error", messageFor("network_error"), 504);
    }
    this.jar.update(url, response.headers);
    if ([401, 403, 421, 450].includes(response.status))
      throw new AppError(
        "reconnect_required",
        messageFor("reconnect_required"),
        401,
      );
    if (response.status === 429)
      throw new AppError("rate_limited", messageFor("rate_limited"), 429);
    if (!response.ok)
      throw new AppError("provider_error", messageFor("provider_error"), 502);
    let data: Record<string, unknown>;
    try {
      const raw = await response.text();
      if (raw.length > 8_000_000) throw new Error("Response too large");
      data = record(JSON.parse(raw));
    } catch {
      throw malformed();
    }
    if (setup) return data;
    if (data.success !== true) {
      const error = record(data.error);
      const hint = `${text(error.errorCode)} ${text(error.errorMessage)}`;
      if (/rate|limit|quota|too many/i.test(hint))
        throw new AppError("rate_limited", messageFor("rate_limited"), 429);
      if (/auth|session|login/i.test(hint))
        throw new AppError(
          "reconnect_required",
          messageFor("reconnect_required"),
          401,
        );
      throw new AppError("provider_error", messageFor("provider_error"), 502);
    }
    return data.result;
  }
  async validate(): Promise<Account> {
    const data = record(await this.request("", "POST", null, true));
    const info = record(data.dsInfo),
      web = record(data.webservices),
      premium = record(web.premiummailsettings);
    const id =
      typeof info.dsid === "number" ? String(info.dsid) : text(info.dsid);
    const email = text(info.appleId || info.primaryEmail || info.appleIdEmail);
    if (!id || !email)
      throw new AppError(
        "reconnect_required",
        messageFor("reconnect_required"),
        401,
      );
    if (!text(premium.url))
      throw new AppError(
        "icloud_unavailable",
        "This session does not expose Hide My Email. Check iCloud+ and the selected region.",
        422,
      );
    this.accountId = id;
    this.serviceUrl = appleUrl(text(premium.url)).toString().replace(/\/$/, "");
    return { id, email, serviceUrl: this.serviceUrl };
  }
  async list(): Promise<RemoteAlias[]> {
    return parseList(await this.request("/v2/hme/list", "GET"));
  }
  async detail(id: string): Promise<RemoteAlias> {
    const result = record(
      await this.request("/v2/hme/get", "POST", { anonymousId: id }),
    );
    try {
      const alias = parseAlias(result.hmeEmail ?? result);
      if (alias.providerId !== id) throw malformed();
      return alias;
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "malformed_response")
        throw error;
      const alias = (await this.list()).find((x) => x.providerId === id);
      if (!alias)
        throw new AppError(
          "not_found",
          "This address is no longer in iCloud.",
          404,
        );
      return alias;
    }
  }
  async generate(): Promise<string> {
    const result = await this.request("/v1/hme/generate", "POST", {
      langCode: "en-us",
    });
    const value = typeof result === "string" ? result : record(result).hme;
    const email = typeof value === "string" ? value : text(record(value).hme);
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw malformed();
    return email.toLowerCase();
  }
  async reserve(email: string, label: string, note: string) {
    await this.request("/v1/hme/reserve", "POST", { hme: email, label, note });
  }
  async metadata(id: string, label: string, note: string) {
    await this.request("/v1/hme/updateMetaData", "POST", {
      anonymousId: id,
      label,
      note,
    });
  }
  async action(action: "deactivate" | "reactivate" | "delete", id: string) {
    await this.request(`/v1/hme/${action}`, "POST", { anonymousId: id });
  }
}
