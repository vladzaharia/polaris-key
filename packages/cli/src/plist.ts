/**
 * Property-list parsing (P2b-05): the binary form (`bplist00`, what Xcode writes into an IPA's
 * `Info.plist`) and the XML form (an entitlements blob, or a hand-written `Info.plist`). Values
 * map to JSON-like ones: dict → object, array → array, string, integer → number (or bigint past
 * 2^53), real → number, bool, date → ISO string, data → Buffer, null → null.
 *
 * Input comes from an untrusted archive, so every offset is bounds-checked, nesting is capped and
 * a reference cycle in a binary plist is refused.
 */

export type PlistValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | Buffer
  | PlistValue[]
  | { [key: string]: PlistValue };

export class PlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlistError";
  }
}

const MAX_DEPTH = 64;

export function parsePlist(buf: Buffer): PlistValue {
  if (buf.subarray(0, 8).toString("latin1") === "bplist00")
    return parseBinary(buf);
  return parseXml(buf.toString("utf8"));
}

// ── Binary ───────────────────────────────────────────────────────────────────────────────────

function readUInt(buf: Buffer, at: number, size: number): number {
  if (at < 0 || at + size > buf.length)
    throw new PlistError("binary plist: offset out of range");
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + buf[at + i]!;
  return v;
}

function parseBinary(buf: Buffer): PlistValue {
  if (buf.length < 40) throw new PlistError("binary plist: too short");
  const t = buf.length - 32;
  const offsetSize = buf[t + 6]!;
  const refSize = buf[t + 7]!;
  const numObjects = readUInt(buf, t + 8, 8);
  const top = readUInt(buf, t + 16, 8);
  const tableOffset = readUInt(buf, t + 24, 8);
  if (
    !offsetSize ||
    !refSize ||
    top >= numObjects ||
    tableOffset + numObjects * offsetSize > t
  )
    throw new PlistError("binary plist: bad trailer");
  const offsets: number[] = [];
  for (let i = 0; i < numObjects; i++)
    offsets.push(readUInt(buf, tableOffset + i * offsetSize, offsetSize));

  const visiting = new Set<number>();
  const obj = (ref: number, depth: number): PlistValue => {
    if (depth > MAX_DEPTH) throw new PlistError("binary plist: too deep");
    if (ref >= numObjects) throw new PlistError("binary plist: bad reference");
    if (visiting.has(ref)) throw new PlistError("binary plist: cycle");
    visiting.add(ref);
    try {
      return decode(offsets[ref]!, depth);
    } finally {
      visiting.delete(ref);
    }
  };

  const lengthAt = (
    at: number,
    info: number,
  ): { len: number; start: number } => {
    if (info !== 0xf) return { len: info, start: at + 1 };
    const marker = buf[at + 1]!;
    if (marker >> 4 !== 0x1) throw new PlistError("binary plist: bad length");
    const size = 1 << (marker & 0xf);
    return { len: readUInt(buf, at + 2, size), start: at + 2 + size };
  };

  const decode = (at: number, depth: number): PlistValue => {
    if (at >= t) throw new PlistError("binary plist: object out of range");
    const marker = buf[at]!;
    const type = marker >> 4;
    const info = marker & 0xf;
    switch (type) {
      case 0x0:
        if (info === 0x8) return false;
        if (info === 0x9) return true;
        return null;
      case 0x1: {
        const size = 1 << info;
        if (at + 1 + size > t)
          throw new PlistError("binary plist: int out of range");
        if (size === 8) {
          const v = buf.readBigInt64BE(at + 1);
          return v >= BigInt(Number.MIN_SAFE_INTEGER) &&
            v <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(v)
            : v;
        }
        if (size > 8) throw new PlistError("binary plist: int too wide");
        return readUInt(buf, at + 1, size);
      }
      case 0x2:
        if (info === 2) return buf.readFloatBE(at + 1);
        if (info === 3) return buf.readDoubleBE(at + 1);
        throw new PlistError("binary plist: bad real");
      case 0x3:
        return new Date(
          (buf.readDoubleBE(at + 1) + 978307200) * 1000,
        ).toISOString();
      case 0x4: {
        const { len, start } = lengthAt(at, info);
        if (start + len > t)
          throw new PlistError("binary plist: data out of range");
        return Buffer.from(buf.subarray(start, start + len));
      }
      case 0x5: {
        const { len, start } = lengthAt(at, info);
        if (start + len > t)
          throw new PlistError("binary plist: string out of range");
        return buf.toString("latin1", start, start + len);
      }
      case 0x6: {
        const { len, start } = lengthAt(at, info);
        if (start + 2 * len > t)
          throw new PlistError("binary plist: string out of range");
        const chars = Buffer.from(buf.subarray(start, start + 2 * len));
        chars.swap16();
        return chars.toString("utf16le");
      }
      case 0x8:
        return readUInt(buf, at + 1, info + 1);
      case 0xa: {
        const { len, start } = lengthAt(at, info);
        const out: PlistValue[] = [];
        for (let i = 0; i < len; i++)
          out.push(obj(readUInt(buf, start + i * refSize, refSize), depth + 1));
        return out;
      }
      case 0xd: {
        const { len, start } = lengthAt(at, info);
        const out: { [key: string]: PlistValue } = {};
        for (let i = 0; i < len; i++) {
          const key = obj(
            readUInt(buf, start + i * refSize, refSize),
            depth + 1,
          );
          if (typeof key !== "string")
            throw new PlistError("binary plist: a dict key is not a string");
          out[key] = obj(
            readUInt(buf, start + (len + i) * refSize, refSize),
            depth + 1,
          );
        }
        return out;
      }
      default:
        throw new PlistError(`binary plist: unknown object type ${type}`);
    }
  };

  return obj(top, 0);
}

// ── XML ──────────────────────────────────────────────────────────────────────────────────────

function unescapeXml(s: string): string {
  return s.replace(
    /&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g,
    (_, e: string) => {
      if (e === "lt") return "<";
      if (e === "gt") return ">";
      if (e === "amp") return "&";
      if (e === "quot") return '"';
      if (e === "apos") return "'";
      const code = e.startsWith("#x")
        ? parseInt(e.slice(2), 16)
        : parseInt(e.slice(1), 10);
      return String.fromCodePoint(code);
    },
  );
}

function parseXml(text: string): PlistValue {
  // Strip the prolog, comments and the DOCTYPE; what is left is <plist>…</plist>.
  const body = text
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[\s\S]*?>/g, "");
  const tokens = body.match(/<\/?[A-Za-z]+(?:\s[^>]*)?\/?>|[^<]+/g) ?? [];
  let i = 0;
  const skipSpace = () => {
    while (
      i < tokens.length &&
      !tokens[i]!.startsWith("<") &&
      !tokens[i]!.trim()
    )
      i++;
  };
  const tagOf = (tok: string) => /^<\/?([A-Za-z]+)/.exec(tok)?.[1] ?? "";
  const textUntil = (tag: string): string => {
    let s = "";
    while (i < tokens.length && tokens[i] !== `</${tag}>`) {
      if (tokens[i]!.startsWith("<"))
        throw new PlistError(`xml plist: unexpected ${tokens[i]} in <${tag}>`);
      s += tokens[i];
      i++;
    }
    if (i >= tokens.length)
      throw new PlistError(`xml plist: <${tag}> not closed`);
    i++;
    return unescapeXml(s);
  };

  const value = (depth: number): PlistValue => {
    if (depth > MAX_DEPTH) throw new PlistError("xml plist: too deep");
    skipSpace();
    const tok = tokens[i++];
    if (!tok || !tok.startsWith("<"))
      throw new PlistError("xml plist: expected a value");
    const tag = tagOf(tok);
    const selfClosing = tok.endsWith("/>");
    switch (tag) {
      case "true":
        return true;
      case "false":
        return false;
      case "string":
        return selfClosing ? "" : textUntil("string");
      case "integer": {
        const s = textUntil("integer").trim();
        const n = Number(s);
        return Number.isSafeInteger(n) ? n : BigInt(s);
      }
      case "real":
        return Number(textUntil("real").trim());
      case "date":
        return textUntil("date").trim();
      case "data":
        return selfClosing
          ? Buffer.alloc(0)
          : Buffer.from(textUntil("data").replace(/\s+/g, ""), "base64");
      case "array": {
        const out: PlistValue[] = [];
        if (selfClosing) return out;
        for (;;) {
          skipSpace();
          if (tokens[i] === "</array>") {
            i++;
            return out;
          }
          out.push(value(depth + 1));
        }
      }
      case "dict": {
        const out: { [key: string]: PlistValue } = {};
        if (selfClosing) return out;
        for (;;) {
          skipSpace();
          if (tokens[i] === "</dict>") {
            i++;
            return out;
          }
          if (tokens[i] !== "<key>")
            throw new PlistError("xml plist: expected <key>");
          i++;
          const key = textUntil("key");
          out[key] = value(depth + 1);
        }
      }
      default:
        throw new PlistError(`xml plist: unknown element <${tag}>`);
    }
  };

  skipSpace();
  if (tagOf(tokens[i] ?? "") !== "plist")
    throw new PlistError("xml plist: no <plist> element");
  i++;
  return value(0);
}
