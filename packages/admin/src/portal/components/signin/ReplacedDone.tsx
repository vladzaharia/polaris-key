import * as React from "react";
import { Button } from "../../../ui/Button.js";
import { AuthTitle } from "../../../ui/auth/index.js";
import { t } from "../../../lib/copy.js";
import { PRIMARY_CLASS } from "./requestParts.js";

/**
 * The done state of a Replace (SIGN-IN.md §3.7): it names both devices, so a phished code cannot
 * trade one of the person's devices for another's unnoticed. No celebration, no timer: the
 * person goes back to the app when ready.
 */
export function ReplacedDone({
  app,
  replaced,
  thisDevice,
  onReturn,
}: {
  app: string;
  replaced: string;
  thisDevice: string;
  onReturn: () => void;
}): React.ReactElement {
  return (
    <>
      <div className="space-y-2">
        <AuthTitle>{t("signin.choice.replacedTitle")}</AuthTitle>
        <p className="text-fg-muted" role="status">
          {t("signin.choice.replacedBody", {
            device: replaced,
            app,
            thisDevice,
          })}
        </p>
      </div>
      <Button
        variant="neutral"
        size="lg"
        className={PRIMARY_CLASS}
        onClick={onReturn}
      >
        {t("signin.return.button", { app })}
      </Button>
    </>
  );
}
