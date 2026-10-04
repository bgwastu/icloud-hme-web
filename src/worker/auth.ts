import type { MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { App } from "./types";
import { AppError } from "./errors";

const keys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const loopback = (host: string) =>
  ["localhost", "127.0.0.1", "[::1]"].includes(host);
export const authenticate: MiddlewareHandler<App> = async (c, next) => {
  if (
    c.env.APP_ENV === "local" &&
    c.env.LOCAL_AUTH === "true" &&
    loopback(new URL(c.req.url).hostname)
  ) {
    c.set("owner", "owner");
    c.set("email", "local development");
    return next();
  }
  const team = c.env.ACCESS_TEAM_DOMAIN;
  const aud = c.env.ACCESS_AUD;
  const token = c.req.header("Cf-Access-Jwt-Assertion");
  if (
    !team ||
    !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team) ||
    !aud ||
    !token
  ) {
    throw new AppError(
      "unauthorized",
      "Sign in through Cloudflare Access to use this app.",
      401,
    );
  }
  try {
    let key = keys.get(team);
    if (!key) {
      key = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
      keys.set(team, key);
    }
    const { payload } = await jwtVerify(token, key, {
      issuer: `https://${team}`,
      audience: aud,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "sub", "email"],
    });
    const email =
      typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    const allowed = (c.env.ALLOWED_EMAILS ?? "")
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    if (!email || !allowed.includes(email))
      throw new Error("Identity is not allowed");
    c.set("owner", "owner");
    c.set("email", email);
  } catch {
    throw new AppError(
      "unauthorized",
      "Your app login expired or is not allowed. Sign in again.",
      401,
    );
  }
  await next();
};

export const protectMutation: MiddlewareHandler<App> = async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("Origin");
    const own = new URL(c.req.url);
    const local = c.env.APP_ENV === "local" && loopback(own.hostname);
    let valid = origin === own.origin || origin === c.env.APP_ORIGIN;
    if (local && origin) {
      try {
        valid = loopback(new URL(origin).hostname);
      } catch {
        valid = false;
      }
    }
    if (!valid)
      throw new AppError(
        "forbidden",
        "This request must come from the app.",
        403,
      );
    if (
      !(c.req.header("Content-Type") ?? "")
        .toLowerCase()
        .startsWith("application/json")
    ) {
      throw new AppError("invalid_content_type", "Use a JSON request.", 415);
    }
  }
  await next();
};
