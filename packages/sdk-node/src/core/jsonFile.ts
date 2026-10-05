// Small persisted JSON files in the product's state directory (the update-health journal, the
// boot guard's slots, local config overrides). Reads never throw — a missing or corrupt file is
// the fallback — and writes are atomic: a temporary file in the same directory, then a rename,
// so a crash mid-write leaves the previous contents rather than half a file.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

/** The parsed file, or `fallback` when it is missing, unreadable or not JSON. */
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Synchronous `readJson`, for state a constructor needs (local config overrides). */
export function readJsonSync<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Write `value` atomically, creating the directory (0700) when needed. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
  await rename(tmp, path);
}
