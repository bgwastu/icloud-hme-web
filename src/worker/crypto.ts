import { AppError } from "./errors";
const encoder = new TextEncoder();
const decode = (value: string) =>
  Uint8Array.from(atob(value), (x) => x.charCodeAt(0));
const encode = (value: Uint8Array) => {
  let binary = "";
  for (let start = 0; start < value.length; start += 32_768)
    binary += String.fromCharCode(...value.subarray(start, start + 32_768));
  return btoa(binary);
};
async function key(secret?: string) {
  if (!secret)
    throw new AppError(
      "setup_required",
      "The session encryption key has not been configured.",
      503,
    );
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = decode(secret);
  } catch {
    throw new AppError("setup_required", "The encryption key is invalid.", 503);
  }
  if (bytes.length !== 32)
    throw new AppError(
      "setup_required",
      "The encryption key must contain 32 random bytes.",
      503,
    );
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function encrypt(
  secret: string | undefined,
  value: unknown,
  context: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
    await key(secret),
    encoder.encode(JSON.stringify(value)),
  );
  return `v1.${encode(iv)}.${encode(new Uint8Array(data))}`;
}
export async function decrypt<T>(
  secret: string | undefined,
  value: string,
  context: string,
): Promise<T> {
  try {
    const [version, iv, data, extra] = value.split(".");
    if (version !== "v1" || !iv || !data || extra)
      throw new Error("Invalid format");
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: decode(iv),
        additionalData: encoder.encode(context),
      },
      await key(secret),
      decode(data),
    );
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch (error) {
    if (error instanceof AppError && error.code === "setup_required")
      throw error;
    throw new AppError(
      "session_unreadable",
      "The saved session cannot be opened. Reconnect iCloud.",
      422,
    );
  }
}
export async function hash(value: unknown): Promise<string> {
  const result = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(JSON.stringify(value)),
    ),
  );
  return Array.from(result, (x) => x.toString(16).padStart(2, "0")).join("");
}
