// The browser's Cloud Sync host codec (U-20.1; WIRE-CONTRACT-V5 §13.10): `HostCodec` over the ring
// engine's derived keys. It holds no key of its own. Every call asks the engine for `ringKeys()`,
// which is null once the ring is locked, and runs client-core's `sealValue`, `openValueAnyName`
// and `blind` through the keys' `withRoot`, so the non-extractable root stays in the vault.
//
// Scope: the current root. An envelope of an adopted older root reads as `invalid` (`kid`) here;
// the browser holds no adopted roots outside the engine's short session.

import {
  blind,
  openValue,
  openValueAnyName,
  sealValue,
  type BlindKind,
  type HostCodec,
  type OpenedValue,
  type SyncJson,
} from "@polaris-key/client-core/sync";
import { ErrorCode } from "../../constants.generated.js";
import { PolarisError } from "../../core/types.js";
import type { RingKeys } from "./rootVault.js";

/** What the codec needs of the engine. */
export interface KeySource {
  hasRoot(): boolean;
  ringKeys(): Promise<RingKeys | null>;
}

const locked = (): PolarisError =>
  new PolarisError(
    ErrorCode.syncLocked,
    "Cloud Sync is locked: there is no root",
  );

/**
 * A name holds no U+0000 except a member's envelope name, `setting U+0000 member` (D-2). The
 * blind input has no length prefix, so a NUL elsewhere could collide two pairs: `seal` takes at
 * most the one separator, `blind` takes none.
 */
const nuls = (s: string): number => s.split("\0").length - 1;
const refuse = (why: string): PolarisError =>
  new PolarisError(ErrorCode.invalidOptions, `Cloud Sync host codec: ${why}`);

export function ringCodec(src: KeySource): HostCodec {
  const keys = async (): Promise<RingKeys> => {
    const k = src.hasRoot() ? await src.ringKeys() : null;
    if (k === null) throw locked();
    return k;
  };
  return {
    get locked() {
      return !src.hasRoot();
    },
    async seal(collection, name, value: SyncJson) {
      if (nuls(name) > 1) throw refuse("a name holds U+0000");
      const k = await keys();
      return k.withRoot((p, root) =>
        sealValue(p, root, collection, name, value),
      );
    },
    async open(collection, name, envelope, aliases = []) {
      const k = await keys();
      return k.withRoot((p, root) =>
        openValue(p, root, collection, name, envelope, aliases),
      );
    },
    async openAny(collection, envelope): Promise<OpenedValue> {
      const k = await keys();
      return k.withRoot((p, root) =>
        openValueAnyName(p, root, collection, envelope),
      );
    },
    async blind(kind: BlindKind, ctx: string, name: string) {
      if (nuls(ctx) > 0 || nuls(name) > 0) throw refuse("a name holds U+0000");
      const k = await keys();
      return k.withRoot((p, root) => blind(p, root, kind, ctx, name));
    },
  };
}
