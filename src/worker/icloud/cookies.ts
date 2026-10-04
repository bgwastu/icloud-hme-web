import { invalid } from "../errors";
import type { Region } from "../../shared/types";
export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  hostOnly: boolean;
  expires?: number;
  secure: boolean;
}
export const rootHost = (region: Region) =>
  region === "china" ? "icloud.com.cn" : "icloud.com";
const domainMatches = (host: string, domain: string) =>
  host === domain || host.endsWith(`.${domain}`);
export function appleUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid("iCloud returned an invalid service address.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !["icloud.com", "icloud.com.cn"].some((domain) =>
      domainMatches(url.hostname, domain),
    )
  ) {
    throw invalid("The service address is not an allowed iCloud HTTPS host.");
  }
  url.hash = "";
  return url;
}
function safe(name: string, value: string) {
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || /[\r\n;\x00]/.test(value))
    throw invalid("The cookie data is invalid.");
}
export function importCookies(input: string, region: Region): Cookie[] {
  if (!input.trim() || input.length > 65_536)
    throw invalid(
      "Paste a cookie header or exported cookie JSON, up to 64 KB.",
    );
  const host = rootHost(region);
  let records: unknown;
  if (/^[\[{]/.test(input.trim())) {
    try {
      records = JSON.parse(input);
    } catch {
      throw invalid("The exported cookie JSON is invalid.");
    }
    if (!Array.isArray(records) && records && typeof records === "object")
      records = (records as { cookies?: unknown }).cookies;
    if (!Array.isArray(records))
      throw invalid("Cookie JSON must contain an array of cookies.");
    const result: Cookie[] = [];
    for (const item of records) {
      if (!item || typeof item !== "object")
        throw invalid("A cookie entry is invalid.");
      const row = item as Record<string, unknown>;
      if (typeof row.name !== "string" || typeof row.value !== "string")
        throw invalid("Cookies need a name and value.");
      safe(row.name, row.value);
      const rawDomain =
        typeof row.domain === "string" ? row.domain.toLowerCase() : `.${host}`;
      const domain = rawDomain.replace(/^\./, "");
      if (!domainMatches(domain, host)) continue;
      const expires =
        typeof row.expirationDate === "number"
          ? row.expirationDate * 1000
          : typeof row.expires === "number" && row.expires >= 0
            ? row.expires < 1e12
              ? row.expires * 1000
              : row.expires
            : undefined;
      result.push({
        name: row.name,
        value: row.value,
        domain,
        path:
          typeof row.path === "string" && row.path.startsWith("/")
            ? row.path
            : "/",
        hostOnly:
          typeof row.hostOnly === "boolean"
            ? row.hostOnly
            : !rawDomain.startsWith("."),
        secure: true,
        expires,
      });
    }
    if (!result.length)
      throw invalid("No cookies for the selected iCloud region were found.");
    return result;
  }
  return input
    .trim()
    .replace(/^cookie:\s*/i, "")
    .split(";")
    .filter((x) => x.trim())
    .map((pair) => {
      const index = pair.indexOf("=");
      if (index < 1)
        throw invalid("The cookie header contains an invalid pair.");
      const name = pair.slice(0, index).trim(),
        value = pair.slice(index + 1).trim();
      safe(name, value);
      return {
        name,
        value,
        domain: host,
        path: "/",
        hostOnly: false,
        secure: true,
      };
    });
}
export class CookieJar {
  constructor(public cookies: Cookie[]) {
    this.cookies = cookies.filter(
      (cookie) => cookie.expires === undefined || cookie.expires > Date.now(),
    );
  }
  header(url: URL): string {
    return this.cookies
      .filter(
        (c) =>
          (c.hostOnly
            ? c.domain === url.hostname
            : domainMatches(url.hostname, c.domain)) &&
          (url.pathname === c.path ||
            (url.pathname.startsWith(c.path) &&
              (c.path.endsWith("/") || url.pathname[c.path.length] === "/"))) &&
          (c.expires === undefined || c.expires > Date.now()),
      )
      .sort((a, b) => b.path.length - a.path.length)
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }
  update(url: URL, headers: Headers) {
    const extended = headers as Headers & {
      getAll?: (name: string) => string[];
      getSetCookie?: () => string[];
    };
    const values =
      extended.getSetCookie?.() ??
      extended.getAll?.("Set-Cookie") ??
      (headers.get("Set-Cookie") ? [headers.get("Set-Cookie")!] : []);
    for (const line of values) {
      const [pair, ...attributes] = line.split(";");
      const split = pair.indexOf("=");
      if (split < 1) continue;
      const name = pair.slice(0, split).trim(),
        value = pair.slice(split + 1).trim();
      try {
        safe(name, value);
      } catch {
        continue;
      }
      const cookie: Cookie = {
        name,
        value,
        domain: url.hostname,
        path: "/",
        hostOnly: true,
        secure: true,
      };
      for (const attribute of attributes) {
        const pos = attribute.indexOf("=");
        const key = (pos < 0 ? attribute : attribute.slice(0, pos))
          .trim()
          .toLowerCase();
        const val = pos < 0 ? "" : attribute.slice(pos + 1).trim();
        if (key === "domain") {
          cookie.domain = val.replace(/^\./, "").toLowerCase();
          cookie.hostOnly = false;
        }
        if (key === "path" && val.startsWith("/")) cookie.path = val;
        if (key === "expires" && Number.isFinite(Date.parse(val)))
          cookie.expires = Date.parse(val);
      }
      const maxAge = attributes.find((x) => /^\s*max-age=/i.test(x));
      if (
        maxAge &&
        /^-?\d+$/.test(maxAge.slice(maxAge.indexOf("=") + 1).trim())
      ) {
        cookie.expires =
          Date.now() + Number(maxAge.slice(maxAge.indexOf("=") + 1)) * 1000;
      }
      if (
        !domainMatches(url.hostname, cookie.domain) ||
        !["icloud.com", "icloud.com.cn"].some((root) =>
          domainMatches(cookie.domain, root),
        )
      )
        continue;
      this.cookies = this.cookies.filter(
        (c) =>
          !(
            c.name === name &&
            c.domain === cookie.domain &&
            c.path === cookie.path
          ),
      );
      if (
        value &&
        (cookie.expires === undefined || cookie.expires > Date.now())
      )
        this.cookies.push(cookie);
    }
  }
}
