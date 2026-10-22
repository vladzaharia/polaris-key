// What a mount puts into a host CLI (the `cli` family of conformance/corpus/v2/ui-matrix.json,
// plans/UK-51.md): which verbs, under which words, and what collides with the host's own
// commands. Pure: the commander and yargs adapters call `planMount` and then register what it
// returns, so both mount the same commands and fail the same way.

import { PolarisError } from "@polaris-key/client-core";
import { PolarisKeyClient, type PolarisKeyClientOptions } from "../client.js";
import type { ClientFactory } from "./commands.js";
import { CLI_VERBS, type CliVerb } from "./kit.js";

/** The default mount: what a person using the host's CLI needs. Developer verbs mount by name. */
export const END_USER: readonly string[] = [
  "activate",
  "deactivate",
  "devices deauthorize",
  "devices list",
  "devices rename",
  "login",
  "logout",
  "status",
  "update apply",
  "update check",
];

/** The options a host that gives its `config` no longer needs (the config says all three). */
export const CONFIG_OPTIONS: readonly string[] = [
  "--base-url",
  "--product",
  "--trust",
];

/** The registration error's code. */
export const COLLISION_CODE = "polaris-verb-collision";

/** The code of a `config` the mount cannot build a client from. */
export const BAD_CONFIG_CODE = "polaris-bad-config";

/** What a verb with no action of its own runs: `tidewater devices` is `tidewater devices list`. */
export const DEFAULT_ACTION: Readonly<Record<string, string>> = {
  devices: "list",
  update: "check",
  config: "list",
  packs: "status",
};

/** The program's generated config: everything `PolarisKeyClient.create` needs but the version. */
export type PolarisCliConfig = Omit<PolarisKeyClientOptions, "version">;

/** What both adapters take to decide the mount. */
export interface MountOptions {
  /** Nest every verb under one word: `mytool license activate`. */
  namespace?: string;
  /**
   * The verbs to mount, as ids (`activate`, `devices list`), a one-word verb's alias, or a group
   * (`devices` takes every `devices …` verb). Default: the end-user set; developer verbs
   * (`config`, `secret`, `mint`, `doctor`, …) mount only when named; `"all"` mounts every verb.
   */
  verbs?: readonly string[] | "all";
  /**
   * A verb whose first word the host already uses: `"error"` (default) fails the registration
   * with `polaris-verb-collision`; `"skip"` drops the verb and warns once.
   */
  onCollision?: "error" | "skip";
  /** Your generated `polarisConfig`. Builds the client, so no factory, pins or flags are needed. */
  config?: PolarisCliConfig;
  /** Called once with the ids `onCollision: "skip"` dropped, for the developer's own log. */
  onSkip?: (skipped: readonly string[]) => void;
  /**
   * Where the skip warning goes. Default: nowhere for the people using the program; stderr when
   * `DEBUG` names `polaris`.
   */
  warn?: (message: string) => void;
}

/** The registration failed: a host command equals a verb the mount adds. */
export class VerbCollisionError extends PolarisError {
  /** Every colliding word, sorted. */
  readonly words: string[];
  /** The two options that resolve it. */
  readonly fixes = ["namespace", "verbs"] as const;
  constructor(words: string[], bin: string) {
    const q = words.map((w) => `"${w}"`);
    const list =
      q.length > 1 ? `${q.slice(0, -1).join(", ")} and ${q.at(-1)}` : q[0]!;
    super(
      COLLISION_CODE,
      `${COLLISION_CODE}: ${list} ${words.length > 1 ? "are" : "is"} already ${words.length > 1 ? "commands" : "a command"}. ` +
        `Set namespace: "license" (${bin} license ${words[0]}), leave ${words.length > 1 ? "them" : "it"} out of verbs, or set onCollision: "skip".`,
    );
    this.name = "VerbCollisionError";
    this.words = words;
  }
}

/** The registration failed: the `config` cannot build a client. */
export class CliConfigError extends PolarisError {
  constructor(message: string) {
    super(BAD_CONFIG_CODE, `${BAD_CONFIG_CODE}: ${message}`);
    this.name = "CliConfigError";
  }
}

const REGENERATE = "run `pkey sdk --lang node --write` to regenerate it";
/** A raw Ed25519 public key, base64url: what a pin is. */
const PIN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Refuse a `config` the CLI cannot work from, at registration, with the command that fixes it:
 * no product slug, no pinned keys (so no license could verify), a pin that is a placeholder, or a
 * base URL that is not an http(s) origin. Throws `CliConfigError`.
 */
export function checkCliConfig(
  config: unknown,
): asserts config is PolarisCliConfig {
  const bad = (what: string): never => {
    throw new CliConfigError(`${what}; ${REGENERATE}.`);
  };
  if (typeof config !== "object" || config === null)
    return bad("config is missing, pass your generated polarisConfig");
  const c = config as {
    productSlug?: unknown;
    baseUrl?: unknown;
    trust?: { pinnedKeys?: unknown };
  };
  if (typeof c.productSlug !== "string" || c.productSlug === "")
    bad("config.productSlug is missing");
  const slug = c.productSlug as string;
  const pins = c.trust?.pinnedKeys;
  if (typeof pins !== "object" || pins === null)
    bad(`config for "${slug}" has no trust.pinnedKeys`);
  const entries = Object.entries(pins as Record<string, unknown>);
  if (entries.length === 0)
    bad(`trust.pinnedKeys for "${slug}" is empty, so no license could verify`);
  for (const [kid, key] of entries)
    if (typeof key !== "string" || !PIN.test(key))
      bad(
        `the pinned key "${kid}" for "${slug}" is not a raw Ed25519 public key (43 base64url characters), as a placeholder is`,
      );
  if (
    c.baseUrl !== undefined &&
    (typeof c.baseUrl !== "string" || !/^https?:\/\/[^/\s]+/i.test(c.baseUrl))
  )
    bad(
      `baseUrl ${JSON.stringify(c.baseUrl)} for "${slug}" is not an http(s) origin such as https://key.plrs.im`,
    );
}

/** A verb's id: its words joined with a space. */
export const verbId = (v: CliVerb): string => v.path.join(" ");

/** The verbs `names` picks, in help order; a name that matches nothing throws. */
export function selectVerbs(
  names: readonly string[] | "all" | undefined,
  all: readonly CliVerb[] = CLI_VERBS,
): CliVerb[] {
  if (names === "all") return [...all];
  if (names === undefined)
    return all.filter((v) => END_USER.includes(verbId(v)));
  const matches = (v: CliVerb, name: string): boolean =>
    verbId(v) === name ||
    (v.aliases ?? []).includes(name) ||
    (v.path.length > 1 && v.path[0] === name);
  for (const n of names)
    if (!all.some((v) => matches(v, n)))
      throw new Error(
        `polaris-unknown-verb: "${n}" is not a verb. Verbs: ${all.map(verbId).join(", ")}.`,
      );
  return all.filter((v) => names.some((n) => matches(v, n)));
}

export interface MountPlan {
  /** What to register, in help order. */
  verbs: CliVerb[];
  /** The ids `onCollision: "skip"` dropped. */
  skipped: string[];
  /** The options to hide once `config` is given. */
  hidden: string[];
}

/** The top-level words a verb takes: the namespace, or its first word and its aliases. */
const wordsOf = (v: CliVerb, namespace: string | undefined): string[] =>
  namespace !== undefined ? [namespace] : [v.path[0]!, ...(v.aliases ?? [])];

/**
 * Decide the mount for a host whose own top-level commands are `host`. Throws
 * `VerbCollisionError` (naming every colliding word) unless `onCollision` is `"skip"`.
 */
export function planMount(
  host: Iterable<string>,
  o: Pick<MountOptions, "namespace" | "verbs" | "onCollision"> & {
    config?: unknown;
  },
  bin = "mytool",
  all: readonly CliVerb[] = CLI_VERBS,
): MountPlan {
  const verbs = selectVerbs(o.verbs, all);
  const taken = new Set(host);
  const colliding = new Set(
    verbs.flatMap((v) => wordsOf(v, o.namespace).filter((w) => taken.has(w))),
  );
  const hidden = o.config ? [...CONFIG_OPTIONS] : [];
  if (colliding.size === 0) return { verbs, skipped: [], hidden };
  if (o.onCollision !== "skip")
    throw new VerbCollisionError([...colliding].sort(), bin);
  const skipped = verbs.filter((v) =>
    wordsOf(v, o.namespace).some((w) => colliding.has(w)),
  );
  return {
    verbs: verbs.filter((v) => !skipped.includes(v)),
    skipped: skipped.map(verbId).sort(),
    hidden,
  };
}

/** Tell the developer about a skipped mount: `onSkip`, and `warn` (or stderr under `DEBUG=polaris`). */
export function reportSkipped(
  plan: MountPlan,
  o: Pick<MountOptions, "onSkip" | "warn">,
  bin: string,
): void {
  if (!plan.skipped.length) return;
  o.onSkip?.(plan.skipped);
  const warn =
    o.warn ??
    (/(^|[,\s])(polaris|\*)/.test(process.env.DEBUG ?? "")
      ? (m: string) => process.stderr.write(`${m}\n`)
      : undefined);
  warn?.(skipWarning(plan.skipped, bin));
}

/** The one warning for a skipped mount. */
export function skipWarning(skipped: readonly string[], bin: string): string {
  return `${bin}: skipped ${skipped.join(", ")}; already a command here.`;
}

/**
 * The client factory a mount uses: the host's own, else one built from `config`
 * (`PolarisKeyClient.create({ ...config, version })`), with the host's `--config-dir` if it has one.
 */
export function clientFactoryFor(o: {
  config?: PolarisCliConfig;
  factory?: ClientFactory;
}): ClientFactory {
  const { config } = o;
  if (!config)
    throw new CliConfigError(
      `pass config (your generated polarisConfig) or a client factory; ${REGENERATE}.`,
    );
  checkCliConfig(config);
  return (f) =>
    PolarisKeyClient.create({
      ...config,
      version: f.version,
      ...(f.configDir ? { configDir: f.configDir } : {}),
    });
}
