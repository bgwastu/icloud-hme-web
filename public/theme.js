// Match the Mantine storage key and apply the theme before the app loads.
// An external script keeps the app's script-src 'self' policy intact.
(() => {
  let preference = "auto";
  try {
    const stored = localStorage.getItem("icloud-hme-color-scheme");
    if (["light", "dark", "auto"].includes(stored)) preference = stored;
  } catch {
    // Browser storage is optional.
  }
  const scheme =
    preference === "auto"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : preference;
  document.documentElement.setAttribute("data-mantine-color-scheme", scheme);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", scheme === "dark" ? "#101419" : "#f7f8fa");
})();
