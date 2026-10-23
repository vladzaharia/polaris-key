/**
 * Where a listing field's value comes from, as a pill under the field, and the two ways back
 * (A-27.12, ST-13's scope):
 *
 *   - **Revert to manifest** runs the existing import (A-18c) for that one field: a preview
 *     (`sources: manifest, overwrite`) to read the manifest's value, then, after the confirm, the
 *     apply with the preview's digest and `fields: [field]` (D6). Nothing is written before the
 *     confirm. A 409 (the manifest changed since the preview) says so and offers Reload.
 *   - **Use Presentation** clears the field through the listing PUT; the name then follows the
 *     product's name again (HA-12), and the pill reads "From Presentation".
 *
 * Listing text is data: shown escaped, never as HTML.
 */

import * as React from "react";
import { channelLabel } from "@polaris-key/manifest";
import { ApiError, type ListingImportChange } from "../../../../../api.js";
import { Button } from "../../../../../ui/Button.js";
import { ConfirmDialog } from "../../../../../ui/ConfirmDialog.js";
import { StatusPill } from "../../../../../ui/StatusPill.js";
import { toast } from "../../../../../ui/toast.js";
import { errorCopy } from "../../../../../lib/errorCopy.js";
import { mutate } from "../../../../data/mutations.js";

/** An import source (or `admin`) as the pill words it. */
export function sourceLabel(source: string): string {
  switch (source) {
    case "admin":
      return "Console";
    case "manifest":
      return ".pkey/distribution";
    case "product":
      return ".pkey/product";
    case "app-store":
      return channelLabel("app-store");
    case "play":
      return channelLabel("google-play");
    case "ms-store":
      return channelLabel("microsoft-store");
    case "godot":
      return "Godot project";
    default:
      return source;
  }
}

const SOURCES = [{ source: "manifest" }];

const show = (v: ListingImportChange["current"]): string =>
  v === null || v === undefined
    ? "—"
    : typeof v === "string"
      ? v
      : Array.isArray(v)
        ? v.join(", ")
        : JSON.stringify(v);

interface Preview {
  digest: string;
  now: string;
  manifest: string;
}

function RevertToManifest({
  slug,
  label,
  path,
  disabledReason,
}: {
  slug: string;
  label: string;
  path: string;
  disabledReason?: string | undefined;
}): React.ReactElement {
  const [busy, setBusy] = React.useState(false);
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [changed, setChanged] = React.useState(false);

  const load = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await mutate("listingImport", slug, {
        sources: SOURCES,
        overwrite: true,
      });
      const c = r.import.changes.find((x) => x.field === path);
      if (!c || c.action === "keep") {
        setPreview(null);
        toast.info(`The manifest has nothing to change in ${label}.`);
        return;
      }
      setChanged(false);
      setPreview({
        digest: r.import.digest,
        now: show(c.current),
        manifest: show(c.proposed),
      });
    } catch (e) {
      toast.error(e, { context: { area: "distribution", thing: "Import" } });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="link"
        loading={busy}
        disabledReason={disabledReason}
        onClick={() => void load()}
      >
        Revert to manifest
      </Button>
      <ConfirmDialog
        open={preview !== null}
        onOpenChange={(o) => {
          if (!o) {
            setPreview(null);
            setChanged(false);
          }
        }}
        title={`Revert ${label} to the manifest?`}
        consequences={
          preview
            ? [
                `Now: ${preview.now}`,
                `Manifest: ${preview.manifest}`,
                "The next resync keeps it in step with the manifest.",
              ]
            : []
        }
        confirmLabel="Revert"
        // A 409 is the Reload notice below, not a second message.
        describeError={(e) =>
          e instanceof ApiError && e.status === 409
            ? null
            : errorCopy(e, { area: "distribution", thing: "Import" })
        }
        onConfirm={async () => {
          try {
            await mutate("listingImport", slug, {
              sources: SOURCES,
              overwrite: true,
              fields: [path],
              confirm: preview!.digest,
            });
          } catch (e) {
            if (e instanceof ApiError && e.status === 409) setChanged(true);
            throw e;
          }
          toast.success(`${label} reverted to the manifest`);
        }}
      >
        {changed ? (
          <div className="flex items-center gap-2 text-sm" role="status">
            <span>The manifest changed since you looked.</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              loading={busy}
              onClick={() => void load()}
            >
              Reload
            </Button>
          </div>
        ) : null}
      </ConfirmDialog>
    </>
  );
}

function UsePresentation({
  slug,
  label,
  body,
  disabledReason,
}: {
  slug: string;
  label: string;
  body: Record<string, unknown>;
  disabledReason?: string | undefined;
}): React.ReactElement {
  const [busy, setBusy] = React.useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="link"
      loading={busy}
      disabledReason={disabledReason}
      onClick={async () => {
        setBusy(true);
        try {
          await mutate("putListing", slug, body);
          toast.success(`${label} now follows Presentation`);
        } catch (e) {
          toast.error(e, {
            context: { area: "distribution", thing: "Listing" },
          });
        } finally {
          setBusy(false);
        }
      }}
    >
      Use Presentation
    </Button>
  );
}

/**
 * The pill and actions for one field. `source` is the field's source when it holds a value
 * (`admin` for typed text), else `null`; `inherited` is true when the field is empty and the
 * product supplies it. `revertPath` is the import's field path when the manifest can supply the
 * field; `presentationBody` is the PUT that clears a field Presentation can supply.
 */
export function FieldSource({
  slug,
  label,
  source,
  inherited,
  revertPath,
  presentationBody,
  disabledReason,
}: {
  slug: string;
  label: string;
  source: string | null;
  inherited: boolean;
  revertPath?: string;
  presentationBody?: Record<string, unknown>;
  /** Set while the form holds unsaved changes: both actions would disagree with the text. */
  disabledReason?: string | undefined;
}): React.ReactElement | null {
  if (source === null && !inherited) return null;
  const words = source !== null ? sourceLabel(source) : "From Presentation";
  return (
    <div
      className="mt-1 flex flex-wrap items-center gap-1 text-xs"
      data-field-source={source ?? "presentation"}
    >
      <StatusPill tone="neutral" icon={false} size="sm">
        {words}
      </StatusPill>
      {source !== null && source !== "manifest" && revertPath ? (
        <RevertToManifest
          slug={slug}
          label={label}
          path={revertPath}
          disabledReason={disabledReason}
        />
      ) : null}
      {source !== null && presentationBody ? (
        <UsePresentation
          slug={slug}
          label={label}
          body={presentationBody}
          disabledReason={disabledReason}
        />
      ) : null}
    </div>
  );
}
