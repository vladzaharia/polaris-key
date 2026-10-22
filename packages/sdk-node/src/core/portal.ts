// The product page link's source (discovery `core.portal`, WIRE-CONTRACT-V4 §5.7, plans/DISC-01.md):
// whether the product's customer portal is on, and the link. The terminal kits read it through
// `client.portal()`; they never fetch discovery for it themselves.
//
// After every successful discovery the member is parsed again (client-core `parsePortal`): a
// document without one (or an invalid one) clears it, and a failed discovery keeps the last.
// `load()` reads the last member from `portal.json` through the same parser, so an offline
// `status` on a portal-off product still draws "Contact" and not a dead link. A file that names
// another product or base, or does not read back as the parser normalises it, is deleted.
//
// The file is `{v:1, product, baseUrl, portal}`, written to a temporary name and renamed. It sits
// in the product's cache directory beside the `presentation/` folder (that folder is pruned to
// the icons the member names, so the file cannot live inside it).

import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  parsePortal,
  type ParsedPortal,
} from "@polaris-key/client-core/portal";
import { writeJson } from "./jsonFile.js";

/** The persisted member's file name. */
export const PORTAL_MEMBER_FILE = "portal.json";
/** `portal.json`'s own format version. */
const MEMBER_FILE_VERSION = 1;

export interface PortalStoreOptions {
  product: string;
  baseUrl: string;
  /** The product's cache directory: `portal.json` lives directly in it. */
  dir: string;
}

/** The member as the wire spells it, so a stored value can be parsed again. */
function wireOf(p: ParsedPortal): Record<string, unknown> {
  return p.enabled && p.activate !== null
    ? { enabled: true, activate: p.activate }
    : { enabled: p.enabled };
}

export class PortalStore {
  private member: ParsedPortal | null = null;
  private discovered = false;

  constructor(private readonly opts: PortalStoreOptions) {}

  private get path(): string {
    return join(this.opts.dir, PORTAL_MEMBER_FILE);
  }

  /** The last parsed member, or null (unknown: an older Worker, or never discovered). */
  current(): ParsedPortal | null {
    return this.member === null ? null : structuredClone(this.member);
  }

  /** Cold boot: the member `portal.json` holds, unless this session discovered one. */
  async load(): Promise<void> {
    const m = await this.read();
    if (!this.discovered && m !== null) this.member = m;
  }

  /** A successful discovery's document: parse, store and persist. Never throws. */
  async accept(doc: { core?: unknown }): Promise<void> {
    this.discovered = true;
    const m = parsePortal(doc.core);
    if (!isDeepStrictEqual(m, this.member)) this.member = m;
    await this.write(m).catch(() => undefined);
  }

  private async write(m: ParsedPortal | null): Promise<void> {
    if (m === null) {
      await rm(this.path, { force: true });
      return;
    }
    await writeJson(this.path, {
      v: MEMBER_FILE_VERSION,
      product: this.opts.product,
      baseUrl: this.opts.baseUrl,
      portal: wireOf(m),
    });
  }

  /** The member the file holds, or null; a file that does not read back to itself is deleted. */
  private async read(): Promise<ParsedPortal | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      return null;
    }
    let v: Record<string, unknown> | null = null;
    try {
      v = JSON.parse(raw) as Record<string, unknown> | null;
    } catch {
      // Not JSON: deleted below.
    }
    let m: ParsedPortal | null = null;
    if (
      v !== null &&
      typeof v === "object" &&
      v.v === MEMBER_FILE_VERSION &&
      v.product === this.opts.product &&
      v.baseUrl === this.opts.baseUrl
    ) {
      m = parsePortal({ portal: v.portal });
      if (m !== null && !isDeepStrictEqual(wireOf(m), v.portal)) m = null;
    }
    if (m === null) await rm(this.path, { force: true }).catch(() => undefined);
    return m;
  }
}
