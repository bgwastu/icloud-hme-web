import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { parse } from "jsonc-parser";

const required = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_ZONE_ID",
  "CLOUDFLARE_D1_DATABASE_ID",
  "ACCESS_TEAM_DOMAIN",
  "ACCESS_AUD",
  "ALLOWED_EMAILS",
  "WORKER_NAME",
  "APP_ORIGIN",
];
for (const name of required)
  if (!process.env[name])
    throw new Error(`Set ${name} before deploying. See README.md.`);
const appEnv = "production";
let origin;
try {
  origin = new URL(process.env.APP_ORIGIN);
} catch {
  throw new Error("APP_ORIGIN must be an HTTPS origin.");
}
if (
  origin.protocol !== "https:" ||
  origin.pathname !== "/" ||
  origin.search ||
  origin.hash
)
  throw new Error("APP_ORIGIN must be an HTTPS origin.");
if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(process.env.ACCESS_TEAM_DOMAIN))
  throw new Error("Invalid ACCESS_TEAM_DOMAIN.");
if (process.env.WORKER_NAME !== "icloud-hme-web")
  throw new Error("WORKER_NAME must be icloud-hme-web.");
if (!/^[a-f0-9]{32}$/.test(process.env.CLOUDFLARE_ZONE_ID))
  throw new Error("Invalid CLOUDFLARE_ZONE_ID.");
const parseErrors = [];
const config = parse(
  await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  parseErrors,
  { allowTrailingComma: true },
);
if (parseErrors.length)
  throw new Error("wrangler.jsonc contains invalid configuration syntax.");
config.name = process.env.WORKER_NAME;
config.account_id = process.env.CLOUDFLARE_ACCOUNT_ID;
config.workers_dev = false;
config.preview_urls = false;
config.routes = [
  {
    pattern: origin.hostname,
    custom_domain: true,
    zone_id: process.env.CLOUDFLARE_ZONE_ID,
  },
];
config.main = "../src/worker/index.ts";
config.assets.directory = "../dist/client";
config.d1_databases = [
  {
    binding: "DB",
    database_name: process.env.WORKER_NAME,
    database_id: process.env.CLOUDFLARE_D1_DATABASE_ID,
    migrations_dir: "../migrations",
  },
];
config.vars = {
  APP_ENV: appEnv,
  LOCAL_AUTH: "false",
  APP_ORIGIN: origin.origin,
  ACCESS_TEAM_DOMAIN: process.env.ACCESS_TEAM_DOMAIN,
  ACCESS_AUD: process.env.ACCESS_AUD,
};
await mkdir(".deploy", { recursive: true, mode: 0o700 });
const configPath = `.deploy/wrangler-${appEnv}.json`;
await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
const childEnv = { ...process.env, WRANGLER_SEND_METRICS: "false" };
delete childEnv.CLOUDFLARE_API_KEY;
delete childEnv.CLOUDFLARE_EMAIL;
async function run(args, input) {
  const output = [];
  const code = await new Promise((resolve, reject) => {
    const child = spawn("npx", ["wrangler", ...args, "--config", configPath], {
      env: childEnv,
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => output.push(chunk));
    if (input) child.stdin.end(input);
    child.on("error", () => reject(new Error("Could not start Wrangler.")));
    child.on("close", resolve);
  });
  if (code !== 0) {
    // Wrangler output can include private deployment configuration.
    // Keep it in an ignored local file instead of public CI logs.
    await writeFile(".deploy/wrangler-output.log", Buffer.concat(output), {
      mode: 0o600,
    });
    throw new Error(
      `Wrangler failed (exit ${code}). See .deploy/wrangler-output.log locally.`,
    );
  }
}
await run(["d1", "migrations", "apply", "DB", "--remote"]);
console.log("Production database migrations applied.");
await run(["deploy"]);
console.log("Production Worker deployed.");
await run(
  ["secret", "put", "ALLOWED_EMAILS"],
  `${process.env.ALLOWED_EMAILS}\n`,
);
if (process.env.SESSION_ENCRYPTION_KEY)
  await run(
    ["secret", "put", "SESSION_ENCRYPTION_KEY"],
    `${process.env.SESSION_ENCRYPTION_KEY}\n`,
  );
console.log("Production deployment complete.");
