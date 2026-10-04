import type { Failure, Snapshot, Operation } from "../shared/types";

export class ApiError extends Error {
  constructor(public details: Failure["error"]) {
    super(details.message);
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      signal: AbortSignal.timeout(45_000),
      headers: method === "GET" ? {} : { "Content-Type": "application/json" },
      ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
    });
  } catch {
    throw new ApiError({
      code: "network_error",
      message: "The connection was interrupted. Try again to check the result.",
      requestId: "",
    });
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new ApiError({
      code: "authentication_required",
      message: "Your app login may have expired. Reload the page to sign in.",
      requestId: "",
    });
  }
  if (!response.ok)
    throw new ApiError(
      (data as Failure).error ?? {
        code: "request_failed",
        message: "The request could not be completed.",
        requestId: "",
      },
    );
  return data as T;
}
export interface MutationResult {
  operation: Operation;
  snapshot: Snapshot;
}

// Keep the same key if the browser loses a response, including across a reload.
// Only a hash of the request is stored in the browser; notes are not persisted here.
const pendingKeys = new Map<string, string>();
export async function mutation(
  path: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<MutationResult> {
  const { operationKey: _ignored, ...fields } = payload;
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify([path, method, fields])),
    ),
  );
  const storageKey = `hme-request-${Array.from(digest, (x) => x.toString(16).padStart(2, "0")).join("")}`;
  let operationKey = pendingKeys.get(storageKey) ?? null;
  try {
    operationKey = sessionStorage.getItem(storageKey);
  } catch {
    /* Storage may be disabled. */
  }
  operationKey ??= crypto.randomUUID();
  pendingKeys.set(storageKey, operationKey);
  try {
    sessionStorage.setItem(storageKey, operationKey);
  } catch {
    /* The server still records the key. */
  }
  try {
    const result = await api<MutationResult>(path, method, {
      ...fields,
      operationKey,
    });
    pendingKeys.delete(storageKey);
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* Optional browser storage. */
    }
    return result;
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.details.operationId ||
        ["invalid_input", "conflict", "busy", "not_found"].includes(
          error.details.code,
        ))
    ) {
      pendingKeys.delete(storageKey);
      try {
        sessionStorage.removeItem(storageKey);
      } catch {
        /* Optional browser storage. */
      }
    }
    throw error;
  }
}
