import * as React from "react";
import { Button } from "../../ui/Button.js";
import { Dialog, DialogBody, DialogFooter } from "../../ui/Dialog.js";
import { Input } from "../../ui/Input.js";
import { useClaimKey } from "../data.js";
import { portalErrorCopy } from "../errors.js";

/** The Activate license modal (PORTAL.md §4.17). PX-01 frame; PX-06 builds the steps. */
export function ActivateDialog({
  open,
  prefill,
  onOpenChange,
}: {
  open: boolean;
  prefill?: string;
  fromProduct?: string;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const [key, setKey] = React.useState(prefill ?? "");
  const claim = useClaimKey();
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Activate a license">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          claim.mutate(key.trim(), { onSuccess: () => onOpenChange(false) });
        }}
      >
        <DialogBody>
          <label className="text-sm font-bold text-fg-strong" htmlFor="pk-key">
            License key
          </label>
          <Input
            id="pk-key"
            mono
            value={key}
            onValueChange={setKey}
            autoComplete="off"
          />
          {claim.error ? (
            <p className="mt-2 text-sm text-danger">
              {portalErrorCopy(claim.error).title}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            loading={claim.isPending}
            disabled={!key.trim()}
          >
            Continue
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
