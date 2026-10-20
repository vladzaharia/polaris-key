import * as React from "react";
import { ShieldCheck } from "lucide-react";
import type { SignInRequestView } from "@polaris-key/protocol/identity";
import { CardHeader } from "../../../ui/auth/index.js";
import { t } from "../../../lib/copy.js";
import { headerModel } from "../../model/signInRequest.js";
import { ProductIcon } from "../ProductIcon.js";

/**
 * The app card's persistent header and footer (SIGN-IN.md §3.1), from the request view alone:
 * the name, icon, developer, origin and device label are the Worker's data, checked against the
 * reserved names; a name that failed the check draws the neutral frame (a shield, the slug, no
 * developer). No query value is ever read here.
 */
export function RequestHeader({
  view,
}: {
  view: SignInRequestView;
}): React.ReactElement {
  const m = headerModel(view);
  return (
    <CardHeader
      variant={m.variant}
      icon={
        m.verified ? (
          <ProductIcon
            slug={m.product}
            name={m.name}
            tint={null}
            size={56}
            src={view.client.iconUrl ?? undefined}
          />
        ) : (
          <span
            aria-hidden
            className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-surface-sunken text-fg-muted"
          >
            <ShieldCheck className="size-7" />
          </span>
        )
      }
      name={m.name}
      developer={m.developer}
      where={m.where}
      code={m.code}
    />
  );
}

/** "Polaris Locker signs you in for <App>. <Developer> never sees your codes or passkeys." */
export function RequestFooter({
  view,
}: {
  view: SignInRequestView;
}): React.ReactElement | null {
  const m = headerModel(view);
  if (!m.developer) return null;
  return (
    <p className="flex items-start gap-2">
      <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>{t("signin.footer", { app: m.name, developer: m.developer })}</span>
    </p>
  );
}
