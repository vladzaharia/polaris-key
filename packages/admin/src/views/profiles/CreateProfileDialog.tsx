import * as React from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
            A profile is a named managed payload. Configure its values after it’s created.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Field label="Id" required error={idError} help="Stable, immutable identifier.">
            <Input
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="default"
              autoFocus
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label="Name" help="Human-friendly name shown in the console.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Default profile" />
          </Field>
          <Field label="Description" help="Optional notes about what this profile is for.">
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Baseline managed configuration for new licenses."
              className="font-sans"
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={saving} disabled={!canSubmit}>
              Create profile
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
