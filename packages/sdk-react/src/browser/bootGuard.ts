// Browser-specific composition for the app boot guard. This stays behind BrowserAdapter's
// dynamic import: an app that only renders the license gate need not pay for boot slots or
// service-worker inspection.

import { BootGuard, browserBootSlotStore } from "../core/bootGuard.js";
import type { BootAttempt, BootGuardOptions } from "../core/bootGuard.js";
import type { ConfigStorage } from "../core/localConfig.js";
import { PolarisError } from "../core/types.js";
import { hasWaitingWorker, pageServiceWorker } from "./serviceWorkerUpdate.js";
import type { SwContainer } from "./serviceWorkerUpdate.js";

export interface BrowserBootGuardOptions extends Omit<
  BootGuardOptions,
  "version" | "store" | "staged"
> {
  product: string;
  version?: string;
  storage?: ConfigStorage | null;
  container?: SwContainer | null;
}

export class BrowserBootGuard extends BootGuard {
  private readonly configuredVersion: string | undefined;

  constructor({
    product,
    version,
    storage,
    container,
    ...opts
  }: BrowserBootGuardOptions) {
    const worker = container === undefined ? pageServiceWorker() : container;
    super({
      ...opts,
      version: version ?? "",
      store: browserBootSlotStore(product, storage),
      staged: () => hasWaitingWorker(worker),
    });
    this.configuredVersion = version;
  }

  override markBootAttempt(): Promise<BootAttempt> {
    this.requireVersion();
    return super.markBootAttempt();
  }

  override confirmBoot(): Promise<void> {
    this.requireVersion();
    return super.confirmBoot();
  }

  private requireVersion(): void {
    if (this.configuredVersion === undefined)
      throw new PolarisError(
        "not-configured",
        "The boot guard counts launches of a build: pass `version` to the adapter.",
      );
  }
}
