// In-memory pack storage and state store (P4-06): the `PackStorage` and `PackStateStore` a test,
// a corpus harness or a page without persistent storage runs the engine over. Nothing survives
// the process; a host that needs packs across launches injects a persistent one (Node's
// directory store, React's OPFS store). Pure: no I/O.

import type { FilesIndexDoc } from "@polaris-key/protocol/packs";
import { sha256Hex, treeDigest } from "./files.js";
import type { InstalledPayload, PackStorage, StagedObject } from "./engine.js";
import { memorySource, sliceSource, type InstalledFile } from "./ports.js";
import type { PackInstall, PackStateStore } from "./state.js";

/** One stored payload: a container's bytes or a tree's files, and the index kept with it. */
export interface MemoryPayload {
  layout: string;
  payload?: Uint8Array;
  tree?: Map<string, Uint8Array>;
  index: FilesIndexDoc | null;
}

export interface MemoryPackStorage extends PackStorage {
  /** The stored payloads by location (`<packId>/<payloadSha256>`, or a host's own key). */
  readonly store: Map<string, MemoryPayload>;
  /** The staged objects by plan id, then SHA-256. */
  readonly staging: Map<string, Map<string, Uint8Array>>;
}

function grow(buf: Uint8Array, need: number): Uint8Array {
  if (need <= buf.byteLength) return buf;
  const out = new Uint8Array(Math.max(need, buf.byteLength * 2));
  out.set(buf);
  return out;
}

/** `PackStorage` over maps. `freeDisk` is what the planner is told (default 1 GiB). */
export function memoryPackStorage(
  opts: { freeDisk?: number } = {},
): MemoryPackStorage {
  const store = new Map<string, MemoryPayload>();
  const staging = new Map<string, Map<string, Uint8Array>>();
  const outputs = new Map<
    string,
    { container: Uint8Array; length: number; tree: Map<string, Uint8Array> }
  >();
  const plan = (planId: string): Map<string, Uint8Array> => {
    let m = staging.get(planId);
    if (!m) staging.set(planId, (m = new Map()));
    return m;
  };

  const storage: MemoryPackStorage = {
    store,
    staging,
    async stagedObject(planId, sha256): Promise<StagedObject> {
      const objects = plan(planId);
      return {
        size: async () => objects.get(sha256)?.byteLength ?? 0,
        source: async () =>
          memorySource(objects.get(sha256) ?? new Uint8Array()),
        append: async (bytes) => {
          const have = objects.get(sha256) ?? new Uint8Array();
          const next = new Uint8Array(have.byteLength + bytes.byteLength);
          next.set(have);
          next.set(bytes, have.byteLength);
          objects.set(sha256, next);
        },
        reset: async () => {
          objects.delete(sha256);
        },
      };
    },
    async output(planId) {
      const o: {
        container: Uint8Array;
        length: number;
        tree: Map<string, Uint8Array>;
      } = {
        container: new Uint8Array(),
        length: 0,
        tree: new Map(),
      };
      outputs.set(planId, o);
      return {
        sink: {
          write: async (offset, bytes) => {
            o.container = grow(o.container, offset + bytes.byteLength);
            o.container.set(bytes, offset);
            o.length = Math.max(o.length, offset + bytes.byteLength);
          },
        },
        tree: {
          writeFile: async (path, bytes) => {
            o.tree.set(path, bytes.slice());
          },
        },
      };
    },
    async commit(planId, packId, payloadSha256, layout, index) {
      const o = outputs.get(planId);
      if (!o) throw new Error(`no output for plan ${planId}`);
      const location = `${packId}/${payloadSha256}`;
      store.set(
        location,
        layout === "tree"
          ? { layout, tree: o.tree, index }
          : { layout, payload: o.container.slice(0, o.length), index },
      );
      outputs.delete(planId);
      return location;
    },
    async installed(install: PackInstall): Promise<InstalledPayload | null> {
      const p = store.get(install.location);
      if (!p) return null;
      if (p.layout === "tree") {
        const files: InstalledFile[] = [];
        for (const [path, bytes] of p.tree ?? [])
          files.push({
            path,
            sha256: await sha256Hex(bytes),
            size: bytes.byteLength,
            source: memorySource(bytes),
          });
        return { payload: null, files };
      }
      const whole = memorySource(p.payload ?? new Uint8Array());
      return {
        payload: whole,
        files:
          p.index?.files.map((f) => ({
            path: f.path,
            sha256: f.sha256,
            size: f.size,
            source: sliceSource(whole, f.offset ?? 0, f.size),
          })) ?? null,
      };
    },
    async verify(install) {
      const p = store.get(install.location);
      if (!p) return false;
      if (p.layout === "tree") {
        const files = [];
        for (const [path, bytes] of p.tree ?? [])
          files.push({
            path,
            size: bytes.byteLength,
            sha256: await sha256Hex(bytes),
          });
        return (await treeDigest(files)) === install.payloadSha256;
      }
      return (
        (await sha256Hex(p.payload ?? new Uint8Array())) ===
        install.payloadSha256
      );
    },
    async remove(location) {
      store.delete(location);
    },
    async removeStaging(planId) {
      staging.delete(planId);
      outputs.delete(planId);
    },
    async list() {
      return { locations: [...store.keys()], plans: [...staging.keys()] };
    },
    async freeDisk() {
      return opts.freeDisk ?? 1 << 30;
    },
  };
  return storage;
}

/** A `PackStateStore` over one string, with its quarantine in `torn`. */
export function memoryPackStateStore(
  initial: string | null = null,
): PackStateStore & {
  text: string | null;
  torn: string | null;
  holdList: string | null;
} {
  const s = {
    text: initial,
    torn: null as string | null,
    holdList: null as string | null,
    read: async () => s.text,
    replace: async (text: string) => {
      s.text = text;
    },
    quarantine: async (text: string) => {
      s.torn ??= text;
    },
    quarantined: async () => s.torn !== null,
    clearQuarantine: async () => {
      s.torn = null;
      s.holdList = null;
    },
    readHoldList: async () => s.holdList,
    writeHoldList: async (text: string) => {
      s.holdList ??= text;
    },
  };
  return s;
}
