let origin;
try {
  origin = new URL(process.env.APP_ORIGIN);
} catch {
  throw new Error("APP_ORIGIN must use HTTPS.");
}
if (origin.protocol !== "https:") throw new Error("APP_ORIGIN must use HTTPS.");
for (const path of ["/", "/logo.svg", "/api/aliases"]) {
  let response;
  try {
    response = await fetch(new URL(path, origin), {
      redirect: "manual",
      headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(`Could not verify Access protection for ${path}.`);
  }
  const location = response.headers.get("Location");
  const accessRedirect =
    location &&
    new URL(location, origin).hostname === process.env.ACCESS_TEAM_DOMAIN;
  const accessBlocked = [401, 403].includes(response.status);
  if (!accessRedirect && !accessBlocked)
    throw new Error(`Access did not protect ${path}: HTTP ${response.status}`);
  console.log(`Access protected ${path}: HTTP ${response.status}`);
}
