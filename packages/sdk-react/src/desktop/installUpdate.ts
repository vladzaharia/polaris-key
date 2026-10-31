// The parts of `DesktopAdapter.installUpdate` that run after the host answers, loaded on demand
// (SIZE-5): an install is rare and the adapter ships in every provider. See the method.
import { PolarisError } from "../core/index.js";
import {
  isWireInstallOutcome,
  notInstallable,
  type InstallOutcome,
} from "../core/install.js";

export { notInstallable };

/** The host's answer as an outcome; a `restartRequired` carries `restart` (the host's own verb). */
export function installOutcome(
  r: unknown,
  restart: () => Promise<void>,
): InstallOutcome {
  if (!isWireInstallOutcome(r))
    throw new PolarisError(
      "unknown",
      "The host answered update.install with something that is not an install outcome.",
    );
  if (r.kind !== "restartRequired") return r;
  return { kind: "restartRequired", version: r.version, restart };
}
