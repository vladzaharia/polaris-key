import * as React from "react";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { api, type ProfileDetail as ProfileDetailDto } from "../../api.js";
import { useResource } from "../../context.js";
import { r } from "../../console/routes.js";
import { absoluteTime, relativeTime } from "../format.js";
import { MetaItem } from "../licenses/shared.js";
import {
  Badge,
  Button,
  EmptyState,
  Skeleton,
} from "../../components/ui/index.js";
import { PayloadEditor } from "./PayloadEditor.js";
import { qk } from "../../console/data/queries.js";

/**
 * A profile's detail view — the managed payload an operator actually edits.
 *
 * WHY A ROUTE AND NOT A DIALOG. This was a `max-w-4xl` modal, and djdl's real catalog is 28+
 * entries: every row competed with the dialog's own scroll container, the action bar sat on top
 * of the field being edited, and the thing an operator most wants to send a colleague — "the
 * profile that is wrong" — had no URL. The console already has a pattern for its largest editor
 * (`LicenseDetail` at `#/p/<slug>/licenses/<id>`), so this is the same shape one level over:
 * back link, header, metadata strip, editor at full page width, deep-linkable, back/forward safe.
 */
export function ProfileDetail({
  slug,
  id,
}: {
  slug: string;
  id: string;
}): React.ReactElement {
  const res = useResource<ProfileDetailDto>(qk.profile(slug, id), () =>
    api.profile(slug, id),
  );
  const backHref = r.profiles(slug);

  if (res.error) {
    return (
      <section className="space-y-6">
        <BackLink href={backHref} />
        <EmptyState
          icon={<AlertTriangle aria-hidden />}
          title="Could not load profile"
          description={res.error}
          action={
            <Button variant="outline" onClick={res.reload}>
              Retry
            </Button>
          }
        />
      </section>
    );
  }

  if (!res.data) {
    return (
      <section className="space-y-6">
        <BackLink href={backHref} />
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-32 w-full" />
      </section>
    );
  }

  const profile = res.data;
  return (
    <section className="space-y-6">
      <BackLink href={backHref} />

      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-2xl font-semibold tracking-tight">
            {profile.name || profile.id}
          </h2>
          <Badge variant="outline" className="font-mono">
            {profile.id}
          </Badge>
        </div>
        <p className="max-w-prose text-sm text-muted-foreground">
          {profile.description ||
            "The managed config, secret, and flag values every license on this profile inherits."}
        </p>
      </header>

      <dl className="grid grid-cols-2 gap-4 rounded-lg border border-border bg-card p-5 sm:grid-cols-3">
        <MetaItem label="Id">
          <span className="font-mono text-xs">{profile.id}</span>
        </MetaItem>
        <MetaItem label="Last modified">
          {profile.modifiedAt ? (
            <span title={absoluteTime(profile.modifiedAt)}>
              {relativeTime(profile.modifiedAt)}
            </span>
          ) : (
            "—"
          )}
        </MetaItem>
        <MetaItem label="Modified by">{profile.modifiedBy ?? "—"}</MetaItem>
      </dl>

      <PayloadEditor slug={slug} profile={profile} />
    </section>
  );
}

function BackLink({ href }: { href: string }): React.ReactElement {
  return (
    <a
      href={href}
      className="inline-flex items-center gap-1.5 rounded-sm text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowLeft className="size-4" aria-hidden />
      Back to profiles
    </a>
  );
}
