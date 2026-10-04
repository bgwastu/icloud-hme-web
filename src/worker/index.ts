import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { App } from "./types";
import { authenticate, protectMutation } from "./auth";
import { AppError } from "./errors";
import { Store, publicConnection, publicOperation } from "./db";
import { Services } from "./services";

const app = new Hono<App>();
app.use("*", async (c, next) => {
  c.set("requestId", crypto.randomUUID());
  c.header("X-Request-Id", c.get("requestId"));
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "same-origin");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  );
  await next();
});
app.get("/health", (c) => c.json({ status: "ok", app: "icloud-hme-web" }));
app.use("/api/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
app.use("/api/*", authenticate);
app.use("/api/*", protectMutation);
app.use(
  "/api/*",
  bodyLimit({
    maxSize: 100_000,
    onError: (c) =>
      c.json(
        {
          error: {
            code: "too_large",
            message: "The request is too large.",
            requestId: c.get("requestId"),
          },
        },
        413,
      ),
  }),
);
const services = (c: Parameters<typeof authenticate>[0]) =>
  new Services(c.env, new Store(c.env.DB, c.get("owner")));
async function body<T>(
  c: Parameters<typeof authenticate>[0],
  schema: z.ZodType<T>,
): Promise<T> {
  let value: unknown;
  try {
    value = await c.req.json();
  } catch {
    throw new AppError(
      "invalid_input",
      "The request must contain valid JSON.",
      400,
    );
  }
  const result = schema.safeParse(value);
  if (!result.success)
    throw new AppError(
      "invalid_input",
      result.error.issues[0]?.message ?? "Check the form fields.",
      400,
    );
  return result.data;
}
const operationKey = z.string().uuid("A valid operation key is required.");
const label = z.string().max(256, "Labels must be 256 characters or fewer.");
const note = z
  .string()
  .max(10_000, "Notes must be 10,000 characters or fewer.");
app.get("/api/me", (c) =>
  c.json({ email: c.get("email"), local: c.env.APP_ENV === "local" }),
);
app.get("/api/icloud/connection", async (c) =>
  c.json({
    connection: publicConnection(await services(c).store.connection()),
  }),
);
app.put("/api/icloud/connection", async (c) => {
  const input = await body(
    c,
    z.object({
      cookies: z.string().min(1).max(65_536),
      region: z.enum(["global", "china"]),
    }),
  );
  const connection = await services(c).connect(input.cookies, input.region);
  return c.json({ connection });
});
app.get("/api/aliases", async (c) =>
  c.json(await services(c).store.snapshot()),
);
app.get("/api/aliases/export", async (c) => {
  const snapshot = await services(c).store.snapshot();
  c.header(
    "Content-Disposition",
    'attachment; filename="icloud-hme-web-aliases.json"',
  );
  return c.json({
    exportedAt: new Date().toISOString(),
    lastSync: snapshot.connection?.lastSync ?? null,
    aliases: snapshot.aliases,
  });
});
app.post("/api/aliases/sync", async (c) => {
  const input = await body(
    c,
    z.object({ automatic: z.boolean().default(false) }),
  );
  return c.json(await services(c).refresh(input.automatic));
});
app.post("/api/aliases", async (c) => {
  const { operationKey: key, ...input } = await body(
    c,
    z.object({
      operationKey,
      label: label.trim().min(1, "Enter a label."),
      note: note.default(""),
    }),
  );
  return c.json(await services(c).mutate("create", key, input), 201);
});
app.get("/api/aliases/:id", async (c) =>
  c.json({ alias: await services(c).detail(c.req.param("id")) }),
);
app.patch("/api/aliases/:id", async (c) => {
  const { operationKey: key, ...input } = await body(
    c,
    z
      .object({
        operationKey,
        baseVersion: z.string().min(1),
        label: label.optional(),
        note: note.optional(),
      })
      .refine(
        (x) => x.label !== undefined || x.note !== undefined,
        "Provide a label or note to update.",
      ),
  );
  return c.json(
    await services(c).mutate("edit", key, input, c.req.param("id")),
  );
});
app.post("/api/aliases/:id/deactivate", async (c) => {
  const input = await body(c, z.object({ operationKey }));
  return c.json(
    await services(c).mutate(
      "deactivate",
      input.operationKey,
      {},
      c.req.param("id"),
    ),
  );
});
app.post("/api/aliases/:id/reactivate", async (c) => {
  const input = await body(c, z.object({ operationKey }));
  return c.json(
    await services(c).mutate(
      "reactivate",
      input.operationKey,
      {},
      c.req.param("id"),
    ),
  );
});
app.delete("/api/aliases/:id", async (c) => {
  const input = await body(
    c,
    z.object({ operationKey, confirmEmail: z.string().min(1) }),
  );
  const service = services(c);
  const connection = await service.store.requireConnection();
  const previous = await service.store.operationKey(
    connection.id,
    input.operationKey,
  );
  if (
    !previous &&
    (await service.store.alias(c.req.param("id"))).email !== input.confirmEmail
  )
    throw new AppError(
      "invalid_input",
      "Confirm the exact address before deleting.",
      400,
    );
  return c.json(
    await service.mutate(
      "delete",
      input.operationKey,
      { confirmEmail: input.confirmEmail },
      c.req.param("id"),
    ),
  );
});
app.get("/api/operations/:id", async (c) =>
  c.json({
    operation: publicOperation(
      await services(c).store.operation(c.req.param("id")),
    ),
  }),
);
app.post("/api/operations/:id/reconcile", async (c) =>
  c.json(await services(c).reconcile(c.req.param("id"))),
);
app.all("/api/*", (c) =>
  c.json(
    {
      error: {
        code: "not_found",
        message: "Endpoint not found.",
        requestId: c.get("requestId"),
      },
    },
    404,
  ),
);
app.onError((error, c) => {
  const safe =
    error instanceof AppError
      ? error
      : new AppError(
          "internal_error",
          "The request could not be completed. Please try again.",
          500,
        );
  if (!(error instanceof AppError))
    console.error("request_failed", c.get("requestId"), error.name);
  return c.json(
    {
      error: {
        code: safe.code,
        message: safe.message,
        requestId: c.get("requestId"),
        ...(safe.operationId ? { operationId: safe.operationId } : {}),
      },
    },
    safe.status as 400,
  );
});
export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: App["Bindings"]) {
    const store = new Store(env.DB, "owner");
    const connection = await store.connection();
    if (connection?.status === "connected") {
      try {
        await new Services(env, store).refresh(true);
      } catch (error) {
        // Background checks never repeat an Apple mutation or log session data.
        console.error(
          "scheduled_sync_failed",
          error instanceof AppError ? error.code : "internal_error",
        );
      }
    }
    if (new Date(controller.scheduledTime).getUTCHours() !== 3) return;
    const configured = Number(env.RETENTION_DAYS ?? 30);
    const days =
      Number.isInteger(configured) && configured >= 30 && configured <= 365
        ? configured
        : 30;
    await store.maintenance(days);
  },
};
