export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public operationId?: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}
export const invalid = (message: string) =>
  new AppError("invalid_input", message, 400);
export function messageFor(code: string): string {
  return (
    (
      {
        reconnect_required: "Sign in to iCloud again to reconnect.",
        rate_limited: "iCloud is limiting requests. Wait before trying again.",
        network_error: "Could not reach iCloud. Try again shortly.",
        unknown_outcome:
          "The result needs checking. Use Check iCloud before retrying.",
        provider_error:
          "iCloud could not complete the change. Try again shortly.",
        malformed_response:
          "Could not update from iCloud. Your saved addresses are still available.",
        conflict:
          "This address changed since you opened it. Review the latest version before saving.",
        busy: "iCloud is updating. Try again shortly.",
      } as Record<string, string>
    )[code] ?? "The request could not be completed."
  );
}
