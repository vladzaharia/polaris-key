import * as React from "react";
import { cn } from "../../lib/cn.js";

/** Initials from a display name, else from the email's local part. */
export function initialsOf(name: string, email: string): string {
  const source = name.trim() && name.trim() !== email ? name.trim() : "";
  if (source) {
    const words = source.split(/\s+/).filter(Boolean);
    const first = words[0]?.[0] ?? "";
    const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "";
    return (first + last).toUpperCase();
  }
  return (email.trim()[0] ?? "?").toUpperCase();
}

/**
 * A stored account picture's path (PX-W16, G33): `/media/avatar/<asset>`, optionally naming a
 * size and a format. Nothing else is ever loaded: the shell's CSP is `img-src 'self' data:`, and a
 * provider's own URL (Google, Steam) must never reach the page (§4.30 rule 3).
 */
const AVATAR_PATH =
  /^\/media\/avatar\/[0-9a-f]{64}(?:-(?:96|256))?(?:\.(?:webp|png))?$/;
const AVATAR_BASE = /^\/media\/avatar\/[0-9a-f]{64}$/;

export type AvatarSize = 32 | 40 | 48 | 56 | 96;

/**
 * The `src` for a picture at a size, or null for anything that is not a stored picture. Up to
 * 48 px the 96 px rendition is enough (2× screens included); larger sizes take the 256 px one.
 */
export function avatarSrc(
  url: string | null | undefined,
  size: AvatarSize,
): string | null {
  if (!url || !AVATAR_PATH.test(url)) return null;
  return size <= 48 && AVATAR_BASE.test(url) ? `${url}-96` : url;
}

const SIZE: Record<AvatarSize, { box: string; text: string; badge: string }> = {
  32: { box: "size-8", text: "text-xs", badge: "size-4 [&_svg]:size-2.5" },
  40: { box: "size-10", text: "text-sm", badge: "size-4 [&_svg]:size-2.5" },
  48: { box: "size-12", text: "text-base", badge: "size-5 [&_svg]:size-3" },
  56: { box: "size-14", text: "text-lg", badge: "size-5 [&_svg]:size-3" },
  96: { box: "size-24", text: "text-3xl", badge: "size-7 [&_svg]:size-4" },
};

/**
 * The one avatar (PORTAL.md §5.2, §4.30 rule 5; EXPERIENCE.md §0.6 P5): the profile picture,
 * else the initials on the core violet tint (the portal is a core surface with no section accent;
 * a console that adopts it must keep that tint, never a section's). It appears in the header chip,
 * the account menu, Account → Profile, and (with PX-14) the consent person row and the TV's done
 * row.
 *
 * **Never before authentication** (§4.30 rule 4): `picture` comes only from the signed-in
 * session or profile (`GET /api/me`, `GET /api/me/profile`); a pre-authentication screen (the
 * known-account chip) renders it without one. Only a stored, same-origin picture path is ever
 * loaded (`avatarSrc`); anything else, or a picture that fails to load, shows the initials.
 *
 * `badge` is the source's mark (the provider the picture came from), drawn small on the edge.
 * The avatar is decorative: the name beside it is the text.
 */
export function Avatar({
  name,
  email,
  picture,
  size = 32,
  badge,
  className,
}: {
  name: string;
  email: string;
  /** The stored picture's URL (`/media/avatar/<asset>`, 256 px), or null for initials. */
  picture?: string | null;
  size?: AvatarSize;
  badge?: React.ReactNode;
  className?: string;
}): React.ReactElement {
  const src = avatarSrc(picture, size);
  const [failed, setFailed] = React.useState<string | null>(null);
  const showPicture = src !== null && failed !== src;
  const s = SIZE[size];
  return (
    <span
      aria-hidden
      data-avatar={showPicture ? "picture" : "initials"}
      className={cn("relative inline-flex shrink-0", s.box, className)}
    >
      {showPicture ? (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          decoding="async"
          draggable={false}
          onError={() => setFailed(src)}
          className={cn("rounded-full bg-surface-sunken object-cover", s.box)}
        />
      ) : (
        <span
          className={cn(
            "inline-flex select-none items-center justify-center rounded-full bg-accent-subtle font-bold text-accent-fg",
            s.box,
            s.text,
          )}
        >
          {initialsOf(name, email)}
        </span>
      )}
      {badge ? (
        <span
          className={cn(
            "absolute -bottom-0.5 -right-0.5 inline-flex items-center justify-center rounded-full bg-surface-raised text-fg-strong ring-2 ring-surface-raised",
            s.badge,
          )}
        >
          {badge}
        </span>
      ) : null}
    </span>
  );
}
