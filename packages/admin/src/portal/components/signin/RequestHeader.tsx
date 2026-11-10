import * as React from "react";
import { Shield, ShieldCheck } from "lucide-react";
import type { SignInRequestView } from "@polaris-key/protocol/identity";
import { CardHeader } from "../../../ui/auth/index.js";
import { cn } from "../../../lib/cn.js";
import { t } from "../../../lib/copy.js";
import { headerModel } from "../../model/signInRequest.js";
import { ProductIcon } from "../ProductIcon.js";

/**
 * The mark of the app a card is about (the sign-in card's and the sign-out card's one drawing): the
 * app's icon, or a neutral bordered tile with its initial (a shield when its name failed the
 * render-time check), large in the passport's pane when there is no art. A registered client's
 * mark carries the product as a badge.
 */
export function AppMark({
  name,
  slug,
  verified,
  iconSrc,
  art,
  badge,
}: {
  name: string;
  /** The product's slug (the icon's tint source). */
  slug: string;
  verified: boolean;
  iconSrc: string | null;
  art: string | null;
  badge: { appName: string; iconUrl: string | null } | null;
}): React.ReactElement {
  // No art: the passport's pane centres the icon, large (96 px), as the Worker's page does.
  const big = art ? undefined : "passport:size-24 passport:rounded-3xl";
  const mark =
    verified && iconSrc ? (
      <ProductIcon
        slug={slug}
        name={name}
        tint={null}
        size={56}
        src={iconSrc}
        className={big}
      />
    ) : (
      <span
        aria-hidden
        className={cn(
          "flex size-14 shrink-0 items-center justify-center rounded-[14px] border border-border bg-surface-sunken text-2xl/8 font-medium text-fg-strong",
          art ? undefined : "passport:text-4xl",
          big,
        )}
      >
        {verified ? (
          (name[0] ?? "?").toUpperCase()
        ) : (
          <Shield className="size-7 text-fg-muted" />
        )}
      </span>
    );
  return badge ? (
    <span className="relative inline-flex" data-client-icon>
      {mark}
      <span className="absolute -bottom-1.5 -end-1.5 rounded-lg bg-surface-raised p-0.5 ring-1 ring-border">
        <ProductIcon
          slug={slug}
          name={badge.appName}
          tint={null}
          size={24}
          src={badge.iconUrl}
        />
      </span>
    </span>
  ) : (
    mark
  );
}

/**
 * The app card's persistent header and footer (SIGN-IN.md §3.1), from the request view alone:
 * the name, icon, developer, origin and device label are the Worker's data, checked against the
 * reserved names; a name that failed the check draws the neutral frame (a shield, the slug, no
 * developer). No query value is ever read here.
 */
export function RequestHeader({
  view,
  onRamp = false,
}: {
  view: SignInRequestView;
  /**
   * The key on-ramp (SIGN-IN.md §3.1): the product-context form, "<Product> · <Developer>" and
   * the device line, from the same request, so the pane never changes between steps.
   */
  onRamp?: boolean;
}): React.ReactElement {
  const m = headerModel(view);
  const art = m.verified ? (view.client.artUrl ?? null) : null;
  const reg = view.client.registered;
  // A registered client shows its own icon (never the product's); the product rides as a badge.
  const icon = (
    <AppMark
      name={m.name}
      slug={m.product}
      verified={m.verified}
      iconSrc={reg ? reg.iconUrl : view.client.iconUrl}
      art={art}
      badge={
        reg
          ? { appName: view.client.appName, iconUrl: view.client.iconUrl }
          : null
      }
    />
  );
  if (onRamp)
    return (
      <CardHeader
        variant="context"
        icon={icon}
        art={art}
        name={m.name}
        developer={m.byline ?? m.developer}
        where={m.where}
      />
    );
  return (
    <CardHeader
      variant={m.variant}
      icon={icon}
      art={art}
      name={m.name}
      developer={m.byline ?? m.developer}
      where={m.where}
      code={m.code}
      attach={view.purpose === "attach"}
      via={m.via}
    />
  );
}

/** "Polaris Locker signs you in for <App>. <Developer> never sees your codes or passkeys." */
export function RequestFooter({
  view,
}: {
  view: SignInRequestView;
}): React.ReactElement {
  const m = headerModel(view);
  return (
    <p className="flex items-start gap-2">
      <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>
        {m.developer
          ? t("signin.footer", { app: m.name, developer: m.developer })
          : t("signin.footerNoDeveloper", { app: m.name })}
      </span>
    </p>
  );
}
