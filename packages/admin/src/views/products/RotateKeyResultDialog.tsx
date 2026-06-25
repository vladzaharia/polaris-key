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
 * Surfaced once key preparation succeeds: shows the new `kid` and freshly-minted public key
 * so the operator can verify trust discovery before activation. The private key never
 * leaves the platform.
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
            Signing key prepared
          </DialogTitle>
          <DialogDescription>
            “{slug}” has a staged signing key. Record the kid and public key,
            then activate it after clients have had a trust-refresh window.
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="space-y-3">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="text-muted-foreground">Staged kid</span>
              <span className="font-mono break-all text-right">
                {result.kid}
              </span>
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
