import { useCallback, useEffect, useState } from "react";
export type LocationChange = Record<string, string | null>;
export function locationHref(search: string, changes: LocationChange) {
  const params = new URLSearchParams(search);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === "") params.delete(key);
    else params.set(key, value);
  }
  return `/${params.size ? `?${params}` : ""}`;
}
export function useAppLocation() {
  const [search, setSearch] = useState(window.location.search);
  useEffect(() => {
    const update = () => setSearch(window.location.search);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  const navigate = useCallback((changes: LocationChange, replace = false) => {
    const href = locationHref(window.location.search, changes);
    const parent = `${window.location.pathname}${window.location.search}`;
    if (href === parent) return;
    if (replace) window.history.replaceState(window.history.state, "", href);
    else window.history.pushState({ hmeParent: parent }, "", href);
    setSearch(window.location.search);
  }, []);
  const close = useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    if (window.history.state?.hmeParent) window.history.back();
    else
      navigate(
        {
          dialog: null,
          step: null,
          ...(params.get("dialog") === "delete" ? {} : { address: null }),
        },
        true,
      );
  }, [navigate]);
  return { search, params: new URLSearchParams(search), navigate, close };
}
