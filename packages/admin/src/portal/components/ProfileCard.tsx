import * as React from "react";
import { Lock, Upload } from "lucide-react";
import { Button } from "../../ui/Button.js";
import { Skeleton } from "../../ui/Skeleton.js";
import { toast } from "../../ui/toast.js";
import type { PortalAccount } from "../api.js";
import { bornLine, PROFILE_COPY as C } from "../copy/profile.js";
import { useProfile } from "../data.js";
import {
  badgeProvider,
  formatBirthdate,
  sourceSummary,
} from "../model/profile.js";
import { Avatar } from "./Avatar.js";
import { providerBadge } from "./Glyphs.js";
import { ProfileEditor } from "./ProfileEditor.js";
import { AccountCard as SectionCard } from "./account/AccountCard.js";

/**
 * Account's first card, Profile (PORTAL.md §4.26, §4.30; PX-22): the avatar with the badge of the
 * provider its picture came from, the screen name, where each came from ("Name typed by you ·
 * picture from Steam (marafox)"), the birth date when there is one (I-33; this page is the only
 * place it shows), **Edit profile**, and **Add a picture** when there is none.
 * Editing happens in place (`ProfileEditor`); focus returns to **Edit profile** after.
 *
 * On a Worker without the profile route (404) the card shows the session's name and picture and
 * no editor (G32's fallback); a failed read says so with a retry.
 */
export function ProfileCard({
  account,
}: {
  account: PortalAccount;
}): React.ReactElement {
  const q = useProfile();
  const profile = q.data ?? null;
  const [editing, setEditing] = React.useState<null | "name" | "picture">(null);
  const editRef = React.useRef<HTMLButtonElement>(null);

  const done = (saved: boolean): void => {
    setEditing(null);
    if (saved) toast.success(C["profile.saved"]);
    requestAnimationFrame(() => editRef.current?.focus());
  };

  const name = profile?.displayName ?? account.name;
  const picture = profile ? (profile.picture?.url ?? null) : account.avatarUrl;
  const badge = profile
    ? badgeProvider(
        profile.picture,
        profile.pictureSource,
        profile.displayNameSource,
      )
    : null;
  const showName = name && name !== account.email ? name : account.email;

  return (
    <SectionCard id="profile" title={C["profile.title"]}>
      {q.isPending ? (
        <div className="flex items-center gap-4" aria-hidden>
          <Skeleton className="size-10 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-64 max-w-full" />
          </div>
        </div>
      ) : editing && profile ? (
        <ProfileEditor
          profile={profile}
          account={account}
          focus={editing}
          onDone={done}
        />
      ) : (
        <div className="space-y-3 @container">
          {/* Narrow: the actions stack under the text; wide: they sit in the right column. */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
            <div className="flex min-w-0 flex-1 flex-col items-start gap-3 min-[360px]:flex-row min-[360px]:items-center">
              <Avatar
                name={name}
                email={account.email}
                picture={picture}
                size={40}
                badge={providerBadge(badge)}
              />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-fg-strong [overflow-wrap:anywhere]">
                  {showName}
                </p>
                {name && name !== account.email ? (
                  <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">
                    {account.email}
                  </p>
                ) : null}
                {profile ? (
                  <p className="text-sm text-fg-muted">
                    {sourceSummary(profile)}
                  </p>
                ) : null}
                {profile?.birthdate ? (
                  <p className="flex items-center gap-1.5 text-sm text-fg-muted">
                    <Lock aria-hidden className="size-3.5 shrink-0" />
                    {bornLine(formatBirthdate(profile.birthdate))}
                  </p>
                ) : null}
              </div>
            </div>
            {profile ? (
              <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
                {!profile.picture ? (
                  <Button
                    variant="ghost"
                    iconStart={<Upload aria-hidden />}
                    onClick={() => setEditing("picture")}
                    className="h-auto min-h-9 max-w-full whitespace-normal py-1.5 text-left max-sm:min-h-11"
                  >
                    {C["profile.addPicture"]}
                  </Button>
                ) : null}
                <Button
                  ref={editRef}
                  variant="outline"
                  aria-label={C["profile.edit"]}
                  onClick={() => setEditing("name")}
                  className="max-sm:min-h-11 max-sm:flex-1"
                >
                  {C["profile.editShort"]}
                </Button>
              </div>
            ) : null}
          </div>
          {q.isError ? (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-3 text-sm"
            >
              <span className="text-danger">{C["profile.loadError"]}</span>
              <Button
                variant="outline"
                loading={q.isFetching}
                onClick={() => void q.refetch()}
              >
                {C["profile.retry"]}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}
