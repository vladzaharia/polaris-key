// Where a web gate adds a floating license to an account (UK-42.21, UK-42.22). `portal` opens the
// Polaris Locker card (the key rides in `#key=` for trusted origins), which handles name and email
// hints and attaching; `app` runs the in-page AddToAccount form on the device-code channel. The
// channel follows discovery: `app` when the identity fragment carries `deviceChoice` (the Worker's
// device start honours the hints and the license choice), otherwise `portal`. The same switch
// routes "Sign in to that account" on a license-owned refusal. A host's explicit `addIn` wins.

export type AddIn = "portal" | "app";

/** The Add channel for a discovery document: `app` with `deviceChoice`, else `portal`. */
export function addInOf(
  discovery: Record<string, unknown> | null | undefined,
): AddIn {
  // The same test as `deviceChoiceOf` in browser/sdk/core/choice.ts (this file stays headless).
  const services = discovery?.services as
    | Record<string, Record<string, unknown> | undefined>
    | undefined;
  const identity = services?.identity;
  return identity?.enabled === true && identity.deviceChoice === true
    ? "app"
    : "portal";
}

/** The channel now: the host's `addIn` when given, else read from the adapter's discovery. A
 *  discovery that fails or is absent reads as `portal`. */
export async function resolveAddIn(
  explicit: AddIn | undefined,
  adapter: { discovery(): Promise<Record<string, unknown> | null> },
): Promise<AddIn> {
  if (explicit) return explicit;
  try {
    return addInOf(await adapter.discovery());
  } catch {
    return "portal";
  }
}
