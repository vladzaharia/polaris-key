import * as React from "react";
import { AlertTriangle } from "lucide-react";
import { api, type ProfileDetail, type ProfileSummary } from "../../api.js";
import { useResource } from "../../context.js";
import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Skeleton,
} from "../../components/ui/index.js";
import { PayloadEditor } from "./PayloadEditor.js";

/**
 * A profile editor dialog: loads the full profile (its redacted payload) on open and hosts the
 * `PayloadEditor` so an admin can edit the catalog-driven managed values. Kept in its own
 * controlled dialog so the heavy schema/payload fetch only happens when a row is opened.
 */
export function ProfileDetailDialog({
  slug,
  summary,
  open,
  onOpenChange,
}: {
  slug: string;
  summary: ProfileSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  if (!summary) return <Dialog open={open} onOpenChange={onOpenChange} />;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {summary.name || summary.id}
            <Badge variant="outline">{summary.id}</Badge>
          </DialogTitle>
          <DialogDescription>
            {summary.description ||
              "Edit the managed config, secret, and flag values for this profile."}
          </DialogDescription>
        </DialogHeader>
        {open ? <Body slug={slug} id={summary.id} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function Body({ slug, id }: { slug: string; id: string }): React.ReactElement {
  const res = useResource<ProfileDetail>(`profile:${slug}:${id}`, () =>
    api.profile(slug, id),
  );

  if (res.loading && !res.data) {
    return (
      <DialogBody>
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      </DialogBody>
    );
  }
  if (res.error || !res.data) {
    return (
      <DialogBody>
        <EmptyState
          icon={<AlertTriangle aria-hidden />}
          title="Could not load profile"
          description={res.error ?? "The profile is unavailable."}
          action={
            <Button variant="outline" onClick={res.reload}>
              Retry
            </Button>
          }
        />
      </DialogBody>
    );
  }
  return <PayloadEditor slug={slug} profile={res.data} />;
}
