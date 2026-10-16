// What a passing document attaches to a request (framework drop-ins plan §5.1). The holder's
// name and email ride in the signed profile; they reach the developer's own code only through
// `holder`, a prototype getter, so no `JSON.stringify`, spread or `console.log` of the context
// can carry them into a log line.

import type {
  BackendContext,
  BackendProblem,
} from "@polaris-key/client-core/backend";
import type { JSONValue } from "@polaris-key/protocol/core";
import type { LicenseDoc } from "@polaris-key/protocol/license";

const hasOwn = (o: object, k: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/** A refusal, ready to send (§14.3). `onRefusal` receives it; `errors: "throw"` raises it. */
export interface Problem extends BackendProblem {
  /** The refusal's code (the body's `code`). */
  code: BackendProblem["body"]["code"];
}

/** The signed-in account's pairwise subject (`profile.user.subject`, SP-54). */
export interface PolarisUser {
  subject: string;
}

/** The verified licence a request carries. */
export class PolarisLicense {
  /** The configured product the document's `aud` names. */
  readonly product: string;
  readonly id: string;
  readonly deviceId: string;
  /** The `license.tier` entitlement's value when it is a string, else null. */
  readonly tier: string | null;
  /** Epoch seconds. */
  readonly issuedAt: number;
  readonly ageSeconds: number;
  readonly #holder: { name: string; email: string } | null;
  readonly #doc: LicenseDoc;

  constructor(context: BackendContext["license"], doc: LicenseDoc) {
    this.product = context.product;
    this.id = context.id;
    this.deviceId = context.deviceId;
    this.tier = context.tier;
    this.issuedAt = context.issuedAt;
    this.ageSeconds = context.ageSeconds;
    this.#holder = context.holder;
    this.#doc = doc;
  }

  /** The signed profile's name and email, when both are strings. Never logged. */
  get holder(): { name: string; email: string } | null {
    return this.#holder ? { ...this.#holder } : null;
  }

  /** Whether boolean entitlement `name` is granted. */
  isEntitled(name: string): boolean {
    return this.value(name) === true;
  }

  /** The entitlement's value, or null when the document has none by that name. */
  value(name: string): JSONValue | null {
    const entitlements = this.#doc.entitlements as Record<string, unknown>;
    if (!hasOwn(entitlements, name)) return null;
    const entry = entitlements[name];
    if (!isPlainObject(entry) || !hasOwn(entry, "value")) return null;
    return (entry.value as JSONValue | undefined) ?? null;
  }

  /** Identifiers only: no holder, no entitlement values, no document. */
  toJSON(): {
    product: string;
    id: string;
    tier: string | null;
    issuedAt: number;
    ageSeconds: number;
  } {
    return {
      product: this.product,
      id: this.id,
      tier: this.tier,
      issuedAt: this.issuedAt,
      ageSeconds: this.ageSeconds,
    };
  }

  [INSPECT](): string {
    return `PolarisLicense ${JSON.stringify(this.toJSON())}`;
  }
}

/** The context every drop-in attaches (`req.polaris`, `c.var.polaris`, the Next handler's second
 *  argument): one shape in every language. */
export interface PolarisAuth {
  /** Set whenever steps 1 to 5 of the verdict pass, so on a step-6 refusal too. */
  license: PolarisLicense | null;
  /** The signed-in account, when the document names a valid one. */
  user: PolarisUser | null;
  /** Set whenever the request was refused. */
  problem: Problem | null;
}
