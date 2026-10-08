/**
 * The registry credential extractor (F-02, plans/F-01.md §6.6; F-21; F-22).
 *
 * How a registry client presents its credential on `pkg.plrs.im`, parsed from the request's
 * `Authorization` header. A leaf module in Core because two services read it: Distribution's
 * feed-read ladder (`services/distribution/registry/authorize.ts`, which re-exports it unchanged)
 * and Release's native publish routes (F-22, `services/release/packages/native/`), which may not
 * import each other (rule 6). The extractor only parses: who the token is, and whether it may
 * read or publish, is decided by `registryTokens.ts` and the caller's ladder.
 *
 * The value is never logged, stored or echoed.
 */

/** A credential as a registry client sent it. Never logged. */
export interface FeedCredential {
  /** `bearer` (`Authorization: Bearer <t>`), `basic` (`Basic base64(user:pass)`), `raw`
   *  (`Authorization: <t>`, Cargo's spelling), or `path` (the Godot editor's `/t/<token>/` URL
   *  segment, which only a URL token satisfies). */
  readonly scheme: "bearer" | "basic" | "raw" | "path";
  readonly token: string;
  /** Basic only: the username, when the token is the password. */
  readonly username?: string;
}

import { base64Decode } from "../platform/bytes.js";

const MAX_AUTHORIZATION = 8_192;

function decodeBase64(s: string): string | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 === 1) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      base64Decode(s),
    );
  } catch {
    return null;
  }
}

/**
 * The credential in `req`'s `Authorization` header, or `null` when there is none or it cannot
 * be parsed. Shapes:
 *   - `Bearer <t>` (npm, OCI after its token dance, SwiftPM, NuGet): the token;
 *   - `Basic base64(user:t)` (pip, uv, Poetry, twine, Gradle, Maven, GodotEnv): the password is
 *     the token, or the username when the password is empty (`base64(t:)`);
 *   - `<t>` with no scheme (Cargo): the whole value.
 * The scheme is matched case-insensitively. Empty tokens, control characters and values over
 * 8 KiB parse as nothing.
 */
export function extractFeedCredential(req: Request): FeedCredential | null {
  const raw = req.headers.get("authorization");
  if (raw === null) return null;
  const value = raw.trim();
  if (value === "" || value.length > MAX_AUTHORIZATION) return null;
  // A header value cannot legitimately carry control characters.
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return null;
  }
  const sp = value.indexOf(" ");
  const scheme = sp === -1 ? "" : value.slice(0, sp).toLowerCase();
  const rest = sp === -1 ? "" : value.slice(sp + 1).trim();
  if (scheme === "bearer") {
    return rest === "" || /\s/.test(rest)
      ? null
      : { scheme: "bearer", token: rest };
  }
  if (scheme === "basic") {
    const decoded = decodeBase64(rest);
    if (decoded === null) return null;
    const colon = decoded.indexOf(":");
    if (colon === -1) return null;
    const username = decoded.slice(0, colon);
    const password = decoded.slice(colon + 1);
    if (password !== "") return { scheme: "basic", token: password, username };
    if (username !== "") return { scheme: "basic", token: username };
    return null;
  }
  // Cargo sends the token as the whole value. A value with a space is some other scheme this
  // host does not speak, and a bare scheme name (`Bearer`, `Basic`) carries no token.
  if (sp === -1)
    return /^(bearer|basic)$/i.test(value)
      ? null
      : { scheme: "raw", token: value };
  return null;
}
