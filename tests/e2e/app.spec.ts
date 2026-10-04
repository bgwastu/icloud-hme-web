import { test, expect, type Page } from "@playwright/test";
import type { Snapshot } from "../../src/shared/types";
async function mockApi(page: Page, connected = true) {
  const data: Snapshot = {
    connection: connected
      ? {
          id: "connection",
          accountEmail: "owner@example.com",
          region: "global",
          status: "connected",
          lastSync: "2026-10-04T01:00:00Z",
          lastError: null,
        }
      : null,
    aliases: connected
      ? [
          {
            id: "1",
            email: "quiet-inbox@icloud.com",
            label: "Newsletter subscriptions",
            note: "Reading without the extra noise.",
            active: true,
            version: "v1",
            verifiedAt: "2026-10-04T01:00:00Z",
            createdAt: null,
          },
          {
            id: "2",
            email: "weekend-trip@icloud.com",
            label: "Travel bookings",
            note: "Hotels, flights, and the occasional adventure.",
            active: true,
            version: "v2",
            verifiedAt: "2026-10-04T01:00:00Z",
            createdAt: null,
          },
          {
            id: "3",
            email: "old-store@icloud.com",
            label: "Old shopping account",
            note: "",
            active: false,
            version: "v3",
            verifiedAt: "2026-10-04T01:00:00Z",
            createdAt: null,
          },
        ]
      : [],
    operations: [],
  };
  let lastPayload: Record<string, unknown> = {},
    writes = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname,
      method = request.method();
    const body = method === "GET" ? {} : request.postDataJSON();
    let response: unknown = data;
    if (path === "/api/me") response = { email: "owner@example.com" };
    else if (path === "/api/icloud/connection" && method === "PUT") {
      data.connection = {
        id: "connection",
        accountEmail: "owner@example.com",
        region: "global",
        status: "connected",
        lastSync: null,
        lastError: null,
      };
      response = { connection: data.connection };
    } else if (path === "/api/aliases" && method === "POST") {
      lastPayload = body;
      writes++;
      data.aliases.push({
        id: "4",
        email: "fresh-address@icloud.com",
        label: body.label,
        note: body.note,
        active: true,
        version: "v4",
        verifiedAt: new Date().toISOString(),
        createdAt: null,
      });
      response = { operation: { status: "succeeded" }, snapshot: data };
    } else if (
      method === "POST" &&
      path.match(/\/aliases\/\d+\/(deactivate|reactivate)$/)
    ) {
      const alias = data.aliases.find((x) => x.id === path.split("/").at(-2))!;
      lastPayload = body;
      writes++;
      alias.active = path.endsWith("/reactivate");
      alias.version = `${alias.version}-${alias.active ? "on" : "off"}`;
      response = { operation: { status: "succeeded" }, snapshot: data };
    } else if (path.match(/\/aliases\/\d+$/)) {
      const alias = data.aliases.find((x) => x.id === path.split("/").at(-1))!;
      if (method === "GET") response = { alias };
      else if (method === "PATCH") {
        lastPayload = body;
        writes++;
        if ("note" in body) alias.note = body.note;
        if ("label" in body) alias.label = body.label;
        alias.version = "changed";
        response = { operation: { status: "succeeded" }, snapshot: data };
      } else if (method === "DELETE") {
        lastPayload = body;
        writes++;
        data.aliases = data.aliases.filter((x) => x.id !== alias.id);
        response = { operation: { status: "succeeded" }, snapshot: data };
      }
    }
    await route.fulfill({ json: response });
  });
  return { data, payload: () => lastPayload, writes: () => writes };
}
test("switches email delivery immediately while preserving unsaved notes", async ({
  page,
}) => {
  const mock = await mockApi(page);
  await page.goto("/?address=1");
  const dialog = page.getByRole("dialog", { name: "Edit address" });
  const toggle = dialog.getByRole("switch", { name: "Receive email" });
  await expect(toggle).toBeEnabled();
  await expect(toggle).toBeChecked();
  await expect(dialog.getByText("Active", { exact: true })).not.toBeVisible();
  await dialog.getByLabel("Notes", { exact: true }).fill("Unsaved note");
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
  expect(mock.data.aliases[0].active).toBe(false);
  expect(mock.writes()).toBe(1);
  await expect(dialog.getByLabel("Notes", { exact: true })).toHaveValue(
    "Unsaved note",
  );
  await expect(dialog.getByText("Changed in iCloud")).not.toBeVisible();
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
  expect(mock.writes()).toBe(2);
  const version = mock.data.aliases[0].version;
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(mock.payload().baseVersion).toBe(version);
  expect(mock.payload().note).toBe("Unsaved note");
});
test("keeps the confirmed delivery state when a switch request fails", async ({
  page,
}) => {
  const mock = await mockApi(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/aliases/1/deactivate", async (route) => {
    await pending;
    await route.fulfill({
      status: 502,
      json: {
        error: { code: "provider_error", message: "Could not update address." },
      },
    });
  });
  await page.goto("/?address=1");
  const dialog = page.getByRole("dialog", { name: "Edit address" });
  const toggle = dialog.getByRole("switch", { name: "Receive email" });
  await expect(toggle).toBeEnabled();
  await dialog.getByLabel("Notes", { exact: true }).fill("Keep this draft");
  try {
    await toggle.click();
    await expect(toggle).toBeDisabled();
    await expect(toggle).toBeChecked();
  } finally {
    release();
  }
  await expect(page.getByText("Could not update address.")).toBeVisible();
  await expect(toggle).toBeEnabled();
  await expect(toggle).toBeChecked();
  await expect(dialog.getByLabel("Notes", { exact: true })).toHaveValue(
    "Keep this draft",
  );
  expect(mock.data.aliases[0].active).toBe(true);
});
test("persists light and dark choices and follows system changes in auto mode", async ({
  page,
}, testInfo) => {
  await mockApi(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-mantine-color-scheme", "dark");
  await page.getByRole("button", { name: "Theme: Auto", exact: true }).click();
  for (const [label, icon] of [
    ["Light", "sun"],
    ["Dark", "moon"],
    ["Auto", "device-desktop"],
  ]) {
    const choice = page.getByRole("menuitemradio", {
      name: label,
      exact: true,
    });
    await expect(choice.locator(`svg.tabler-icon-${icon}`)).toBeVisible();
    await expect(choice.locator("svg")).toHaveCount(1);
    await expect(choice).toHaveAttribute(
      "aria-checked",
      String(label === "Auto"),
    );
  }
  await page.screenshot({
    path: `test-results/theme-menu-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("menuitemradio", { name: "Light", exact: true }).click();
  await expect(html).toHaveAttribute("data-mantine-color-scheme", "light");
  await page.reload();
  await expect(html).toHaveAttribute("data-mantine-color-scheme", "light");
  await page.getByRole("button", { name: "Theme: Light", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Dark", exact: true }).click();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html).toHaveAttribute("data-mantine-color-scheme", "dark");
  await page.reload();
  await expect(html).toHaveAttribute("data-mantine-color-scheme", "dark");
  expect(
    await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
  ).toBe("rgb(16, 20, 25)");
  await page
    .getByRole("link", { name: "Open Newsletter subscriptions" })
    .click();
  await expect(
    page.getByRole("switch", { name: "Receive email" }),
  ).toBeEnabled();
  await page.screenshot({
    path: `test-results/editor-dark-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Theme: Dark", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Auto", exact: true }).click();
  await expect(html).toHaveAttribute("data-mantine-color-scheme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html).toHaveAttribute("data-mantine-color-scheme", "dark");
  await page.reload();
  await expect(html).toHaveAttribute("data-mantine-color-scheme", "dark");
  await expect(page.getByRole("button", { name: "Theme: Auto" })).toBeVisible();
  await page.screenshot({
    path: `test-results/aliases-dark-${testInfo.project.name}.png`,
    fullPage: true,
  });
});
test("applies the saved theme before the app starts under a strict script policy", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript(() => {
    localStorage.setItem("icloud-hme-color-scheme", "dark");
  });
  await page.route("**/", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        "content-security-policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'",
      },
    });
  });
  await page.route("**/assets/*.js", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute(
    "data-mantine-color-scheme",
    "dark",
  );
  expect(
    await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
  ).toBe("rgb(16, 20, 25)");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    "#101419",
  );
  await expect(page.getByRole("button", { name: "More options" })).toHaveCount(
    0,
  );
});
test("logs out through Access without disconnecting the Apple account", async ({
  page,
}) => {
  const mock = await mockApi(page);
  await page.route("**/cdn-cgi/access/logout", (route) =>
    route.fulfill({ contentType: "text/html", body: "Signed out" }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "More options" }).click();
  await page.getByRole("menuitem", { name: "Logout", exact: true }).click();
  await expect(page).toHaveURL(/\/cdn-cgi\/access\/logout$/);
  expect(mock.writes()).toBe(0);
  expect(mock.data.connection?.status).toBe("connected");
  expect(mock.data.aliases).toHaveLength(3);
});
test("connects through the first-use wizard without retaining the pasted cookie", async ({
  page,
}) => {
  await mockApi(page, false);
  await page.emulateMedia({ reducedMotion: "reduce" });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/icloud/connection", async (route) => {
    await pending;
    await route.fallback();
  });
  await page.goto("/");
  await expect(
    page.getByRole("dialog", { name: "Connect iCloud" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/dialog=connect.*step=import/);
  await page.getByLabel("iCloud cookies").fill("session=test-cookie");
  const connect = page.getByRole("button", {
    name: "Connect iCloud",
    exact: true,
  });
  try {
    await connect.click();
    await expect(connect).toBeDisabled();
    await expect(connect).toHaveAttribute("aria-busy", "true");
    await expect(connect).not.toHaveAttribute("data-loading");
    await expect(connect.locator(".mantine-Loader-root")).toHaveCount(0);
    await expect(connect.locator(".mantine-Button-label")).toHaveCSS(
      "opacity",
      "1",
    );
  } finally {
    release();
  }
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByRole("status")).toContainText("iCloud connected");
  expect(await page.content()).not.toContain("session=test-cookie");
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ),
  ).not.toContain("test-cookie");
});
test("stops skeleton animation and switches pending creation to a disabled button when motion is reduced", async ({
  page,
}) => {
  const mock = await mockApi(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  let releaseLoad!: () => void, releaseCreate!: () => void;
  const loading = new Promise<void>((resolve) => {
    releaseLoad = resolve;
  });
  const creating = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  await page.route("**/api/aliases", async (route) => {
    await (route.request().method() === "GET" ? loading : creating);
    await route.fallback();
  });
  try {
    await page.goto("/");
    const addresses = page.getByRole("region", {
      name: "Addresses",
      exact: true,
    });
    await expect(addresses).toHaveAttribute("aria-busy", "true");
    const skeleton = addresses.locator(".mantine-Skeleton-root").first();
    await expect(skeleton).toBeVisible();
    expect(
      await skeleton.evaluate(
        (element) => getComputedStyle(element, "::after").animationName,
      ),
    ).toBe("none");
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    releaseLoad();
    await expect(addresses).toHaveAttribute("aria-busy", "false");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.getByRole("button", { name: "New address" }).click();
    await page
      .getByRole("textbox", { name: "Label", exact: true })
      .fill("Reduced motion account");
    const create = page.getByRole("button", {
      name: "Create address",
      exact: true,
    });
    await create.click();
    await expect(create).toBeDisabled();
    await expect(create).toHaveAttribute("data-loading", "true");
    await expect(create.locator(".mantine-Loader-root")).toBeVisible();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(create).toBeDisabled();
    await expect(create).toHaveAttribute("aria-busy", "true");
    await expect(create).not.toHaveAttribute("data-loading");
    await expect(create.locator(".mantine-Loader-root")).toHaveCount(0);
    await expect(create.locator(".mantine-Button-label")).toHaveCSS(
      "opacity",
      "1",
    );
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    releaseCreate();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(
      page.getByText("Reduced motion account", { exact: true }),
    ).toBeVisible();
    expect(mock.writes()).toBe(1);
  } finally {
    releaseLoad();
    releaseCreate();
  }
});
test("uses disabled controls without spinners for reduced-motion edits, delivery changes and deletion", async ({
  page,
}) => {
  const mock = await mockApi(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const releases: Record<string, () => void> = {};
  const pending = Object.fromEntries(
    ["PATCH", "POST", "DELETE"].map((method) => [
      method,
      new Promise<void>((resolve) => {
        releases[method] = resolve;
      }),
    ]),
  );
  await page.route(/\/api\/aliases\/1(?:\/deactivate)?$/, async (route) => {
    if (route.request().method() !== "GET")
      await pending[route.request().method()];
    await route.fallback();
  });
  try {
    await page.goto("/?address=1");
    const dialog = page.getByRole("dialog", { name: "Edit address" });
    const toggle = dialog.getByRole("switch", { name: "Receive email" });
    await expect(toggle).toBeEnabled();
    await dialog
      .getByLabel("Notes", { exact: true })
      .fill("Static pending controls");
    const save = dialog.getByRole("button", { name: "Save changes" });
    await save.click();
    await expect(save).toBeDisabled();
    await expect(save).toHaveAttribute("aria-busy", "true");
    await expect(save).not.toHaveAttribute("data-loading");
    await expect(save.locator(".mantine-Loader-root")).toHaveCount(0);
    await expect(save.locator(".mantine-Button-label")).toHaveCSS(
      "opacity",
      "1",
    );
    releases.PATCH();
    await expect(save).toHaveAttribute("aria-busy", "false");
    await expect(toggle).toBeEnabled();
    await toggle.click();
    await expect(toggle).toBeDisabled();
    await expect(toggle).toHaveAttribute("aria-busy", "true");
    await expect(dialog.locator(".mantine-Loader-root")).toHaveCount(0);
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    releases.POST();
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toBeEnabled();
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await page
      .getByLabel("Type the address to confirm")
      .fill("quiet-inbox@icloud.com");
    const remove = page.getByRole("button", {
      name: "Delete permanently",
      exact: true,
    });
    await remove.click();
    await expect(remove).toBeDisabled();
    await expect(remove).toHaveAttribute("aria-busy", "true");
    await expect(remove).not.toHaveAttribute("data-loading");
    await expect(remove.locator(".mantine-Loader-root")).toHaveCount(0);
    await expect(remove.locator(".mantine-Button-label")).toHaveCSS(
      "opacity",
      "1",
    );
    releases.DELETE();
    await expect(page.getByText("Address deleted")).toBeVisible();
    expect(mock.writes()).toBe(3);
  } finally {
    Object.values(releases).forEach((release) => release());
  }
});
test("creates an alias and clears a note while preserving the label", async ({
  page,
}) => {
  const mock = await mockApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "New address" }).click();
  await page
    .getByRole("textbox", { name: "Label", exact: true })
    .fill("New account");
  await page.getByLabel("Notes (optional)").fill("Created in the browser");
  await page
    .getByRole("button", { name: "Create address", exact: true })
    .click();
  await expect(page.getByText("New account", { exact: true })).toBeVisible();
  expect(mock.payload().operationKey).toMatch(/^[a-f\d-]{36}$/);
  await page
    .getByRole("link", { name: "Open Newsletter subscriptions" })
    .click();
  await page.getByRole("textbox", { name: "Notes", exact: true }).fill("");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(mock.payload().note).toBe("");
  expect(mock.payload()).not.toHaveProperty("label");
});
test("requires exact address confirmation and restores keyboard focus after cancel", async ({
  page,
}) => {
  const mock = await mockApi(page);
  await page.goto("/");
  await page
    .getByRole("link", { name: "Open Newsletter subscriptions" })
    .click();
  const deleteButton = page.getByRole("button", {
    name: "Delete",
    exact: true,
  });
  await deleteButton.click();
  await expect(
    page.getByRole("button", { name: "Delete permanently", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Edit address" }),
  ).toBeVisible();
  await expect(deleteButton).toBeFocused();
  await deleteButton.click();
  await page.getByLabel("Type the address to confirm").fill("wrong@icloud.com");
  await expect(
    page.getByRole("button", { name: "Delete permanently", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("Type the address to confirm")
    .fill("quiet-inbox@icloud.com");
  await page
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await expect(page.getByText("Address deleted")).toBeVisible();
  expect(mock.writes()).toBe(1);
  expect(mock.payload().confirmEmail).toBe("quiet-inbox@icloud.com");
});
test("filters aliases and fits desktop and mobile screens", async ({
  page,
}, testInfo) => {
  await mockApi(page);
  await page.goto("/");
  await expect(
    page.getByText("Newsletter subscriptions", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/aliases-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 320, height: 740 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(
    page.locator(".address-row").first().getByText("Active", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("radiogroup")
    .getByText("Inactive", { exact: true })
    .click();
  await expect(
    page.getByText("Old shopping account", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Travel bookings", { exact: true }),
  ).not.toBeVisible();
  await page.getByRole("radiogroup").getByText("All", { exact: true }).click();
  await page.getByLabel("Search addresses").fill("hotels");
  await expect(
    page.getByText("Travel bookings", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Newsletter subscriptions", { exact: true }),
  ).not.toBeVisible();
});
test("reuses the creation key after a lost browser response", async ({
  page,
}) => {
  await mockApi(page);
  let firstKey: string | undefined,
    attempts = 0;
  await page.route("**/api/aliases", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON();
    attempts++;
    if (attempts === 1) {
      firstKey = body.operationKey;
      return route.abort("failed");
    }
    expect(body.operationKey).toBe(firstKey);
    return route.fallback();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "New address" }).click();
  await page
    .getByRole("textbox", { name: "Label", exact: true })
    .fill("Interrupted create");
  await page
    .getByRole("button", { name: "Create address", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "connection was interrupted",
  );
  await page
    .getByRole("button", { name: "Create address", exact: true })
    .click();
  await expect(page.getByText("Address created")).toBeVisible();
  expect(attempts).toBe(2);
});
test("keeps a note draft through a conflict and modal navigation, then saves against the reviewed version", async ({
  page,
}) => {
  const mock = await mockApi(page);
  let patches = 0;
  await page.route("**/api/aliases/1", async (route) => {
    if (route.request().method() !== "PATCH" || patches++ > 0)
      return route.fallback();
    Object.assign(mock.data.aliases[0], {
      label: "Changed elsewhere",
      note: "Current Apple note",
      version: "new-version",
    });
    await route.fulfill({
      status: 409,
      json: {
        error: {
          code: "conflict",
          message: "Review the current iCloud version.",
          requestId: "test-request",
        },
      },
    });
  });
  await page.goto("/");
  await page
    .getByRole("link", { name: "Open Newsletter subscriptions" })
    .click();
  await page
    .getByRole("textbox", { name: "Notes", exact: true })
    .fill("My unsaved draft");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByText("Changed in iCloud", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Notes", exact: true }),
  ).toHaveValue("My unsaved draft");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("link", { name: "Open Changed elsewhere" }).click();
  await expect(
    page.getByRole("textbox", { name: "Notes", exact: true }),
  ).toHaveValue("My unsaved draft");
  await page.getByRole("button", { name: "Keep my edits" }).click();
  await expect(
    page.getByRole("textbox", { name: "Label", exact: true }),
  ).toHaveValue("Changed elsewhere");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(mock.payload().baseVersion).toBe("new-version");
  expect(mock.payload().note).toBe("My unsaved draft");
  expect(mock.payload()).not.toHaveProperty("label");
});

test("keeps search, filters and address modals in the URL through reload, Back and Forward", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/?q=hotels&status=active");
  await expect(page.getByLabel("Search addresses")).toHaveValue("hotels");
  await page.getByRole("link", { name: "Open Travel bookings" }).click();
  await expect(page).toHaveURL(/q=hotels&status=active&address=2/);
  await expect(
    page.getByRole("dialog", { name: "Edit address" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Notes", exact: true }),
  ).toHaveValue("Hotels, flights, and the occasional adventure.");
  await page.goBack();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByLabel("Search addresses")).toHaveValue("hotels");
  await page.goForward();
  await expect(
    page.getByRole("dialog", { name: "Edit address" }),
  ).toBeVisible();
});

test("syncs without a refresh button and opens the reconnect wizard after expiry", async ({
  page,
}) => {
  const mock = await mockApi(page);
  let syncs = 0;
  await page.route("**/api/aliases/sync", async (route) => {
    syncs++;
    mock.data.connection!.status = "reconnect_required";
    await route.fulfill({
      status: 401,
      json: {
        error: {
          code: "reconnect_required",
          message: "Reconnect iCloud.",
          requestId: "test",
        },
      },
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("dialog", { name: "Reconnect iCloud" }),
  ).toBeVisible();
  expect(syncs).toBe(1);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Open Newsletter subscriptions" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "New address", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: /Refresh|Settings/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("iCloud cookies").fill("session=new-cookie");
  await page
    .getByRole("button", { name: "Connect iCloud", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "New address", exact: true }),
  ).toBeEnabled();
});

test("opens a deletion deep link, traps keyboard focus and keeps mobile actions visible", async ({
  page,
}, testInfo) => {
  await mockApi(page);
  await page.goto("/?address=1&dialog=delete");
  const dialog = page.getByRole("dialog", { name: "Delete address" });
  await expect(dialog).toBeVisible();
  await page
    .getByLabel("Type the address to confirm")
    .fill("quiet-inbox@icloud.com");
  await expect(
    page.getByRole("button", { name: "Delete permanently" }),
  ).toBeInViewport();
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press("Tab");
    expect(
      await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/delete-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page).toHaveURL(/address=1$/);
  await expect(
    page.getByRole("dialog", { name: "Edit address" }),
  ).toBeVisible();
});

test("automatic sync preserves an unsaved note and exposes an external change for review", async ({
  page,
}) => {
  await page.clock.install();
  const mock = await mockApi(page);
  let syncs = 0;
  await page.route("**/api/aliases/sync", async (route) => {
    syncs++;
    await route.fallback();
  });
  await page.goto("/");
  await expect.poll(() => syncs).toBe(1);
  await page
    .getByRole("link", { name: "Open Newsletter subscriptions" })
    .click();
  await page
    .getByRole("textbox", { name: "Notes", exact: true })
    .fill("Draft kept through sync");
  Object.assign(mock.data.aliases[0], {
    note: "Changed in Apple settings",
    version: "external",
  });
  await page.clock.fastForward(300_000);
  await expect.poll(() => syncs).toBe(2);
  await expect(
    page.getByRole("textbox", { name: "Notes", exact: true }),
  ).toHaveValue("Draft kept through sync");
  await expect(
    page.getByText("Changed in iCloud", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save changes" }),
  ).toBeDisabled();
});

test("does not enable notes from the cache when iCloud omits the current note", async ({
  page,
}) => {
  const mock = await mockApi(page);
  await page.route("**/api/aliases/1", async (route) => {
    await route.fulfill({
      json: { alias: { ...mock.data.aliases[0], note: null } },
    });
  });
  await page.goto("/?address=1");
  await expect(
    page.getByText(
      "iCloud did not return this note. Reopen the address to try again.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Notes", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("textbox", { name: "Label", exact: true })
    .fill("Edited label");
  await expect(
    page.getByRole("button", { name: "Save changes" }),
  ).toBeDisabled();
  expect(mock.writes()).toBe(0);
});
