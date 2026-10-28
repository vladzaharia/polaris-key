// The sign-out step of Cloud Connect (decision D-12), kept off the public facade: the adapter
// registers it as a before-sign-out hook, and it stops Connect within a bound, never failing.

const steps = new WeakMap<object, () => Promise<void>>();

/** Remember how to stop `client` for a sign-out. */
export function setSignOutStop(
  client: object,
  step: () => Promise<void>,
): void {
  steps.set(client, step);
}

/** Stop `client`'s Connect for a sign-out: bounded, forced past the bound, never throws. A client
 *  that never loaded its engine has nothing to stop. */
export async function stopForSignOut(client: object): Promise<void> {
  try {
    await steps.get(client)?.();
  } catch {
    // a sign-out never fails because of Connect
  }
}
