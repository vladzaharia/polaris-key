/**
 * A minimal reader for a gzipped tar (npm tarballs, PyPI sdists): find one member by a path test
 * and return its bytes. ustar, with GNU long names (`L`) and pax `path` records; members are
 * streamed through, never all held. Bounded: a member over `maxBytes` is refused.
 */

import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { PackageExtractError } from "./types.js";

const BLOCK = 512;

function cString(buf: Buffer, start: number, len: number): string {
  const end = buf.indexOf(0, start);
  return buf
    .subarray(start, end === -1 || end > start + len ? start + len : end)
    .toString("utf8");
}

function octal(buf: Buffer, start: number, len: number): number {
  const s = cString(buf, start, len).trim();
  return s === "" ? 0 : parseInt(s, 8);
}

/** The bytes of the first member whose path `want` accepts, or null when there is none. */
export async function readTarMember(
  file: string,
  want: (path: string) => boolean,
  maxBytes = 4 * 1024 * 1024,
): Promise<{ path: string; data: Buffer } | null> {
  const stream = createReadStream(file).pipe(createGunzip());
  let buf = Buffer.alloc(0);
  let longName: string | null = null;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < BLOCK) break;
        const header = buf.subarray(0, BLOCK);
        if (header.every((b) => b === 0)) return null;
        const size = octal(header, 124, 12);
        const type = String.fromCharCode(header[156] ?? 48);
        const padded = Math.ceil(size / BLOCK) * BLOCK;
        if (buf.length < BLOCK + padded) break;
        const body = buf.subarray(BLOCK, BLOCK + size);
        const prefix = cString(header, 345, 155);
        let name =
          longName ?? (prefix ? `${prefix}/` : "") + cString(header, 0, 100);
        longName = null;
        if (type === "L") longName = body.toString("utf8").replace(/\0+$/, "");
        else if (type === "x") {
          const m = /\d+ path=([^\n]*)\n/.exec(body.toString("utf8"));
          if (m) longName = m[1]!;
        } else if ((type === "0" || type === "\0") && want(name)) {
          if (size > maxBytes)
            throw new PackageExtractError(
              `${name} in ${file} is ${size} bytes; pkey reads at most ${maxBytes}.`,
            );
          return { path: name, data: Buffer.from(body) };
        }
        name = "";
        buf = buf.subarray(BLOCK + padded);
      }
    }
  } catch (e) {
    if (e instanceof PackageExtractError) throw e;
    throw new PackageExtractError(
      `${file} is not a readable gzipped tar (${(e as Error).message}).`,
    );
  } finally {
    stream.destroy();
  }
  return null;
}
