import * as React from "react";
import { AlertTriangle } from "lucide-react";
import {
  api,
  ApiError,
  type OverrideUpdate,
  type ProductCatalog,
  type ProfileDetail,
} from "../../api.js";
import { invalidate, useResource } from "../../context.js";
import { ManagedPayloadEditor } from "../../ManagedPayloadEditor.js";
import {
  Button,
  EmptyState,
  Skeleton,
  useToast,
} from "../../components/ui/index.js";

/**
 * The managed-payload editor for one profile: load the product catalog, hand it plus the
 * profile's redacted payload to the shared `ManagedPayloadEditor`, and PUT the batch it hands
 * back. Everything visible — grouping, filtering, set-vs-unset, inline validation, the dirty
 * bar — is the shared component's, which is the same one the license override tab renders.
 *
 * The only profile-specific behaviour lives here: which endpoint takes the batch, and what a
 * 422 means. `putProfilePayload` answers a failed catalog check with `fields: string[]`, each
 * one prefixed with the dotted key it concerns, so those go straight back into the editor to
 * be matched onto rows instead of being flattened into a toast that names no control.
 */
export function PayloadEditor({
  slug,
  profile,
}: {
  slug: string;
  profile: ProfileDetail;
}): React.ReactElement {
  const toast = useToast();
  const schemaRes = useResource<ProductCatalog>(`schema:${slug}`, () =>
    api.schema(slug),
  );
  const [saving, setSaving] = React.useState(false);
  const [serverFields, setServerFields] = React.useState<
    string[] | undefined
  >();

  const handleSubmit = async (updates: OverrideUpdate[]): Promise<void> => {
    if (updates.length === 0) return;
    setSaving(true);
    setServerFields(undefined);
    try {
      await api.putProfilePayload(slug, profile.id, updates);
      toast.success(
        "Payload saved",
        `Updated ${updates.length} ${updates.length === 1 ? "key" : "keys"}.`,
      );
      invalidate(`profile:${slug}:${profile.id}`);
      invalidate(`profiles:${slug}`);
    } catch (err) {
      if (err instanceof ApiError && err.fields?.length) {
        // Row-level, not a toast: the worker already told us which keys are wrong.
        setServerFields(err.fields);
        toast.error(
          "Could not save payload",
          "Some values were rejected — see the highlighted keys.",
        );
      } else {
        toast.error("Could not save payload", describeError(err));
      }
    } finally {
      setSaving(false);
    }
  };

  if (schemaRes.loading && !schemaRes.data) {
    return (
      <div className="space-y-3" aria-busy="true">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
    );
  }

  if (schemaRes.error || !schemaRes.data) {
    return (
      <EmptyState
        icon={<AlertTriangle aria-hidden />}
        title="Could not load the catalog"
        description={
          schemaRes.error ??
          "The product's config catalog is unavailable, so there is nothing to edit."
        }
        action={
          <Button variant="outline" onClick={schemaRes.reload}>
            Retry
          </Button>
        }
      />
    );
  }

  return (
    <ManagedPayloadEditor
      slug={slug}
      catalog={schemaRes.data}
      payload={profile.payload}
      saving={saving}
      serverFields={serverFields}
      submitLabel="Save payload"
      onSubmit={handleSubmit}
    />
  );
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409)
      return "This product has no active catalog to validate against.";
    return err.message || `Request failed (${err.status}).`;
  }
  return err instanceof Error ? err.message : "Request failed.";
}
