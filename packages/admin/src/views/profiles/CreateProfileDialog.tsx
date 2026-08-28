import * as React from "react";
import { docsUrl } from "../../lib/docsLinks.js";
import {
  Button,
  Dialog,
  DialogActionBar,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Textarea,
} from "../../components/ui/index.js";

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export interface CreateProfileBody {
  id: string;
  name?: string;
  description?: string;
}

/**
 * CREATE THEN EDIT. A profile is an id, a name, and a payload — and the payload is the product's
 * whole catalog, which belongs on the profile's own page, not in a modal. So this dialog asks
 * for identity only and the caller navigates straight to the editor.
 *
 * It used to split three fields across an "Identity"/"Notes" tab pair, which hid the optional
 * description behind a click and made a two-line form look like a wizard. One pane, three
 * fields, in reading order.
 */
export function CreateProfileDialog({
  open,
  onOpenChange,
  existingIds,
  saving,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingIds: string[];
  saving: boolean;
  onCreate: (body: CreateProfileBody) => void;
}): React.ReactElement {
  const [id, setId] = React.useState("");
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");

  React.useEffect(() => {
    if (open) {
      setId("");
      setName("");
      setDescription("");
    }
  }, [open]);

  const trimmedId = id.trim();
  const idError =
    trimmedId === ""
      ? undefined
      : !ID_PATTERN.test(trimmedId)
        ? "Lowercase letters, digits, '-' and '_' only."
        : existingIds.includes(trimmedId)
          ? "A profile with this id already exists."
          : undefined;
  const canSubmit = trimmedId !== "" && !idError && !saving;

  const submit = (): void => {
    if (!canSubmit) return;
    const body: CreateProfileBody = { id: trimmedId };
    if (name.trim()) body.name = name.trim();
    if (description.trim()) body.description = description.trim();
    onCreate(body);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onEscapeKeyDown={(e) => saving && e.preventDefault()}
        onInteractOutside={(e) => saving && e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>New profile</DialogTitle>
          <DialogDescription>
            A profile is a named managed payload. Name it here — its config,
            secret, and flag values are set on the profile’s own page next.{" "}
            <a
              className="underline underline-offset-2 hover:text-foreground"
              href={docsUrl("createProfile")}
              target="_blank"
              rel="noreferrer"
            >
              Learn more
            </a>
          </DialogDescription>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <DialogBody>
            <div className="space-y-4">
              <Field
                label="Id"
                required
                error={idError}
                help="Stable, immutable identifier."
              >
                <Input
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                  placeholder="default"
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                />
              </Field>
              <Field
                label="Name"
                help="Human-friendly name shown in the console."
              >
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Default profile"
                />
              </Field>
              <Field
                label="Description"
                help="Optional notes about what this profile is for."
              >
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Baseline managed configuration for new licenses."
                  className="font-sans"
                  rows={3}
                />
              </Field>
            </div>
          </DialogBody>

          <DialogActionBar>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" loading={saving} disabled={!canSubmit}>
              Create &amp; configure
            </Button>
          </DialogActionBar>
        </form>
      </DialogContent>
    </Dialog>
  );
}
