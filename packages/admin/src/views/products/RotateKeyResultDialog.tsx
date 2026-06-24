import * as React from "react";
import { KeyRound } from "lucide-react";
import type { RotateKeyResult } from "../../api.js";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/index.js";

/**
 * Surfaced once a key rotation succeeds: shows the new `kid` and the freshly-minted public key
 * (the only point at which the public key is returned) so the operator can update verification
 * tooling. The private key never leaves the platform.
 */
export function RotateKeyResultDialog({
  slug,
  result,
  onOpenChange,
}: {
  slug: string;
  result: RotateKeyResult | null;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  return (
    <Dialog open={result != null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound aria-hidden className="size-5 text-primary" />
            Signing key rotated
          </DialogTitle>
          <DialogDescription>
            “{slug}” now signs with a new key. Record the new kid and public key in your verification
            tooling — old releases stay valid under the previous key.
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="space-y-3">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="text-muted-foreground">New kid</span>
              <span className="font-mono break-all text-right">{result.kid}</span>
            </div>
            <div className="space-y-1">
              <span className="text-sm text-muted-foreground">Public key</span>
              <pre className="max-h-48 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs font-mono whitespace-pre-wrap break-all">
                {result.publicKey}
              </pre>
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
