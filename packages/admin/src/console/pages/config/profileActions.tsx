import * as React from "react";
import { ApiError } from "../../../api.js";
import { confirmFor } from "../../../lib/actions.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { Drawer, DrawerBody, DrawerFooter } from "../../../ui/Drawer.js";
import { FormField } from "../../../ui/form.js";
import { Input } from "../../../ui/Input.js";
import { Textarea } from "../../../ui/Textarea.js";
import { toast } from "../../../ui/toast.js";
import { mutate } from "../../data/mutations.js";

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** Why a profile cannot be deleted right now (PRF-2), or `undefined` when it can. */
export function deleteBlockedReason(usedBy?: {
  tiers: number;
  licenses: number;
}): string | undefined {
  if (!usedBy) return undefined;
  const parts: string[] = [];
  if (usedBy.tiers)
    parts.push(`${usedBy.tiers} ${usedBy.tiers === 1 ? "tier" : "tiers"}`);
  if (usedBy.licenses)
    parts.push(
      `${usedBy.licenses} ${usedBy.licenses === 1 ? "license" : "licenses"}`,
    );
  return parts.length
    ? `Used by ${parts.join(", ")}. Detach them first.`
    : undefined;
}

/**
 * The create errors, told apart (PRF-5): a taken id is the profile's own problem; anything else
 * goes through the console's error copy.
 */
export function createProfileError(err: unknown): string {
  if (err instanceof ApiError && err.reason === "profile_exists")
    return "That id is already in use.";
  if (err instanceof ApiError && err.reason === "no_active_catalog")
    return "Publish a catalog first: a profile's values are checked against it.";
  const copy = errorCopy(err, { thing: "Profile" });
  return copy.description || copy.title;
}

/** Whether a create refusal belongs on the Id field (a taken id) rather than to the form. */
export function isIdError(err: unknown): boolean {
  return err instanceof ApiError && err.reason === "profile_exists";
}

/**
 * "New profile" (T2's create drawer): identity only. A profile's payload is the product's whole
 * catalog, so it is edited on the profile's own page, where the caller navigates next.
 */
export function CreateProfileDrawer({
  slug,
  open,
  onOpenChange,
  existingIds,
  onCreated,
}: {
  slug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingIds: string[];
  onCreated: (id: string) => void;
}): React.ReactElement {
  const [id, setId] = React.useState("");
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [touched, setTouched] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setId("");
      setName("");
      setDescription("");
      setServerError(null);
      setFormError(null);
      setTouched(false);
    }
  }, [open]);
  const unsaved =
    !saving && (id.trim() !== "" || name.trim() !== "" || description !== "");

  const trimmed = id.trim();
  const idError =
    trimmed === ""
      ? touched
        ? "Enter an id."
        : undefined
      : !ID_PATTERN.test(trimmed)
        ? "Lowercase letters, digits, - and _ only, starting with a letter or digit."
        : existingIds.includes(trimmed)
          ? "That id is already in use."
          : undefined;

  const submit = async (): Promise<void> => {
    setTouched(true);
    if (trimmed === "" || idError) return;
    setSaving(true);
    setServerError(null);
    setFormError(null);
    try {
      const body: { id: string; name?: string; description?: string } = {
        id: trimmed,
      };
      if (name.trim()) body.name = name.trim();
      if (description.trim()) body.description = description.trim();
      const created = await mutate("createProfile", slug, body);
      toast.success(`Created profile ${trimmed}`, {
        description: "Set its values next.",
      });
      onOpenChange(false);
      onCreated(created?.id ?? trimmed);
    } catch (err) {
      // Only a taken id is the Id field's problem; anything else belongs to the form (C-33).
      if (isIdError(err)) setServerError(createProfileError(err));
      else setFormError(createProfileError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      dismissible={!saving}
      unsaved={unsaved}
      title="New profile"
      description="Its values are set on its own page next."
    >
      <form
        className="contents"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <DrawerBody>
          <div className="space-y-4">
            <FormField
              name="id"
              label="Id"
              required
              help="Stable: tiers and licenses refer to it. It cannot change later."
              value={id}
              error={idError ?? serverError ?? undefined}
              announceError={touched}
            >
              {(f) => (
                <Input
                  {...f}
                  mono
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="e.g. base-pro"
                  value={id}
                  onChange={(e) => {
                    setId(e.target.value);
                    setServerError(null);
                  }}
                />
              )}
            </FormField>
            <FormField
              name="name"
              label="Name"
              help="Shown in the console. Defaults to the id."
              value={name}
            >
              {(f) => (
                <Input
                  {...f}
                  placeholder="e.g. Base (Pro)"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              )}
            </FormField>
            <FormField
              name="description"
              label="Description"
              value={description}
            >
              {(f) => (
                <Textarea
                  {...f}
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              )}
            </FormField>
            {formError ? (
              <Callout tone="danger" title="The profile wasn't created" live>
                {formError}
              </Callout>
            ) : null}
          </div>
        </DrawerBody>
        <DrawerFooter>
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            Create profile
          </Button>
        </DrawerFooter>
      </form>
    </Drawer>
  );
}

/** "Edit details…" (A-7, PRF-1): name and description. The id never changes. */
export function EditProfileDrawer({
  slug,
  profile,
  open,
  onOpenChange,
}: {
  slug: string;
  profile: { id: string; name: string; description?: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const [name, setName] = React.useState(profile.name);
  const [description, setDescription] = React.useState(
    profile.description ?? "",
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setName(profile.name);
      setDescription(profile.description ?? "");
      setError(null);
    }
  }, [open, profile.name, profile.description]);

  const nameError = name.trim() === "" ? "Enter a name." : undefined;
  const changed =
    name.trim() !== profile.name ||
    description.trim() !== (profile.description ?? "").trim();

  const submit = async (): Promise<void> => {
    if (nameError || !changed) return;
    setSaving(true);
    setError(null);
    try {
      const body: { name?: string; description?: string | null } = {};
      if (name.trim() !== profile.name) body.name = name.trim();
      if (description.trim() !== (profile.description ?? "").trim())
        body.description =
          description.trim() === "" ? null : description.trim();
      await mutate("patchProfile", slug, profile.id, body);
      toast.success("Profile details saved");
      onOpenChange(false);
    } catch (err) {
      const copy = errorCopy(err, { thing: "Profile" });
      setError(`${copy.title}. ${copy.description}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      dismissible={!saving}
      unsaved={changed && !saving}
      title="Edit details"
      description={
        <>
          Profile <code className="font-mono text-xs">{profile.id}</code>
        </>
      }
    >
      <form
        className="contents"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <DrawerBody>
          <div className="space-y-4">
            <FormField
              name="name"
              label="Name"
              required
              value={name}
              error={nameError}
            >
              {(f) => (
                <Input
                  {...f}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              )}
            </FormField>
            <FormField
              name="description"
              label="Description"
              help="Leave empty to remove it."
              value={description}
            >
              {(f) => (
                <Textarea
                  {...f}
                  rows={4}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              )}
            </FormField>
            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
          </div>
        </DrawerBody>
        <DrawerFooter>
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            loading={saving}
            disabledReason={
              nameError
                ? "Enter a name."
                : !changed
                  ? "Nothing has changed."
                  : undefined
            }
          >
            Save details
          </Button>
        </DrawerFooter>
      </form>
    </Drawer>
  );
}

/** Delete (L2, `profile.delete`): only an unreferenced profile, which the caller guarantees. */
export function DeleteProfileDialog({
  slug,
  profileId,
  open,
  onOpenChange,
  onDeleted,
}: {
  slug: string;
  profileId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}): React.ReactElement {
  const policy = confirmFor("profile.delete");
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      intent={policy.intent === "none" ? "neutral" : policy.intent}
      title={`Delete profile ${profileId}?`}
      consequences={[
        "Its values are deleted. Nothing points at it, so no tier or license changes.",
        "This cannot be undone.",
      ]}
      confirmLabel="Delete profile"
      describeError={(e) => errorCopy(e, { thing: "Profile" })}
      onConfirm={async () => {
        await mutate("deleteProfile", slug, profileId);
        toast.success(`Deleted profile ${profileId}`);
        onDeleted?.();
      }}
    />
  );
}
