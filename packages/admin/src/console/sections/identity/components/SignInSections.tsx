/**
 * The App sign-in page's read-mostly cards (I-29): Status, Sign-in methods, Terms and
 * Presentation. Product connection, License keys and the Polaris Locker card are beside them.
 */

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Building2,
  Gamepad2,
  Lock,
  Mail,
  type LucideIcon,
} from "lucide-react";
import {
  api,
  type PlatformConnectionsPage,
  type ProductDetail,
} from "../../../../api.js";
import { cn } from "../../../../lib/cn.js";
import { Callout } from "../../../../ui/Callout.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { ProductLogo } from "../../../../ui/ProductLogo.js";
import { ServiceGlyph } from "../../../../ui/ServiceBadge.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Switch } from "../../../../ui/Switch.js";
import { toast } from "../../../../ui/toast.js";
import { useCan, useWriteGate } from "../../../access/useCan.js";
import { mutate } from "../../../data/mutations.js";
import { qk } from "../../../data/queries.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { SettingsRow, SettingsSection } from "../../../templates/Settings.js";
import { ServiceOffConfirmation } from "../../core/components/ServiceOffConfirmation.js";
import {
  featureWord,
  patchFor,
  type OffConfirmation,
} from "../../core/components/serviceFeatures.js";
import { fetchPlatformConnections } from "../../platform/pages/platformConnections.js";

export const linkClass = "text-accent-fg underline underline-offset-2";

/** The 36 px tile before a row's name: a glyph, or a letter for a brand with no glyph. */
export function IconTile({
  icon: Icon,
  letter,
  children,
}: {
  icon?: LucideIcon;
  letter?: string;
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <span
      aria-hidden
      className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface-sunken text-sm font-semibold text-fg-muted"
    >
      {children ?? (Icon ? <Icon className="size-4" /> : letter)}
    </span>
  );
}

/** A row's name with its tile before it. */
export function Tiled({
  tile,
  children,
}: {
  tile: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-3">
      {tile}
      <span>{children}</span>
    </span>
  );
}

/** A fact that is always so: a word and a lock, never a switch. */
export function Always({ children }: { children: string }): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-fg-muted">
      <Lock className="size-4" aria-hidden />
      {children}
    </span>
  );
}

/** Status: the Sign-in feature switch. Off asks first (it names Cloud Sync, which needs it). */
export function StatusSection({
  slug,
  name,
  enabled,
}: {
  slug: string;
  name: string;
  enabled: boolean;
}): React.ReactElement {
  const queryClient = useQueryClient();
  // The same gate as Settings → Features: the switch is a Core setting.
  const gate = useWriteGate("core", slug, "Settings");
  const busy = React.useRef(false);
  const [working, setWorking] = React.useState(false);
  const [off, setOff] = React.useState<OffConfirmation | null>(null);

  const change = (on: boolean) => ({
    feature: "sign-in" as const,
    label: "Sign-in",
    on,
    requested: ["identity" as const],
    body: patchFor(["identity"], on),
  });
  const refocus = (): void => {
    requestAnimationFrame(() =>
      document.getElementById("app-sign-in-status")?.focus(),
    );
  };
  const commit = async (
    on: boolean,
    slugs: readonly ("identity" | "sync")[] = ["identity"],
  ): Promise<void> => {
    const next = await mutate("updateServices", slug, patchFor(slugs, on));
    queryClient.setQueryData(qk.services(slug), next);
    void queryClient.invalidateQueries({ queryKey: qk.product(slug) });
    const names = slugs.map(featureWord);
    toast.success(
      `${names.join(" and ")} ${names.length === 1 ? "is" : "are"} ${on ? "on" : "off"}`,
      on
        ? undefined
        : {
            action: {
              label: "Undo",
              onClick: () => {
                void mutate("updateServices", slug, patchFor(slugs, true))
                  .then((n) => {
                    queryClient.setQueryData(qk.services(slug), n);
                    void queryClient.invalidateQueries({
                      queryKey: qk.product(slug),
                    });
                  })
                  .catch((e) => toast.error(e));
              },
            },
          },
    );
  };
  const toggle = async (on: boolean): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    setWorking(true);
    try {
      if (on) {
        await commit(true);
        return;
      }
      const dryRun = await mutate("servicesDryRun", slug, change(false).body);
      setOff({ change: change(false), dryRun });
    } catch (error) {
      toast.error(error);
    } finally {
      busy.current = false;
      setWorking(false);
    }
  };

  return (
    <SettingsSection id="status" title="Status">
      <SettingsRow
        label={
          <Tiled
            tile={
              <IconTile>
                <ServiceGlyph id="identity" size={16} />
              </IconTile>
            }
          >
            Sign-in
          </Tiled>
        }
        htmlFor="app-sign-in-status"
      >
        <Switch
          id="app-sign-in-status"
          checked={enabled}
          aria-busy={working}
          aria-disabled={!gate.allowed || undefined}
          aria-label={`Sign-in for ${name}`}
          onCheckedChange={(on) => {
            if (!gate.allowed) return;
            void toggle(on);
          }}
        />
      </SettingsRow>
      <ServiceOffConfirmation
        productName={name}
        confirmation={off}
        onOpenChange={(open) => {
          if (!open) {
            setOff(null);
            refocus();
          }
        }}
        onConfirm={async () => {
          if (!off) return;
          const slugs = ["identity", ...off.dryRun.cascaded].filter(
            (s): s is "identity" | "sync" => s === "identity" || s === "sync",
          );
          await commit(false, slugs);
        }}
      />
    </SettingsSection>
  );
}

const BUILT_INS = [
  { kind: "apple", label: "Apple", letter: "A" },
  { kind: "google", label: "Google", letter: "G" },
  { kind: "steam", label: "Steam", icon: Gamepad2 },
] as const;

/** What the platform offers on every card: the built-in providers and the SSO connections. */
export function MethodsSection({ slug }: { slug: string }): React.ReactElement {
  // Reading the connections is platform access; anyone else sees what the platform sets.
  const canPlatform = useCan("platform", null, "view");
  const settings = useQuery({
    queryKey: qk.signInSettings(slug),
    queryFn: () => api.signInSettings(slug).then((res) => res.settings),
  });
  const q = useQuery<PlatformConnectionsPage>({
    queryKey: qk.platformConnections(),
    queryFn: fetchPlatformConnections,
    enabled: canPlatform,
    retry: false,
  });
  const page = q.data;
  const known = canPlatform && page !== undefined;
  const customers = (page?.connections ?? []).filter(
    (c) => c.status === "active" && c.audience !== "operators",
  );
  const domains = customers.reduce(
    (n, c) => n + c.domains.filter((d) => d.verified).length,
    0,
  );
  const shown = customers.slice(0, 2).map((c) => c.label);
  const names =
    customers.length > 2
      ? `${shown.join(", ")} and ${customers.length - 2} more`
      : shown.join(", ");
  const sso = !known
    ? "Set by the platform"
    : customers.length === 0
      ? "No connection signs customers in"
      : `${names} · ${domains} ${domains === 1 ? "domain" : "domains"}`;

  return (
    <SettingsSection id="methods" title="Sign-in methods">
      <SettingsRow
        label={
          <Tiled tile={<IconTile icon={Mail} />}>Email code and passkeys</Tiled>
        }
      >
        <Always>Always on</Always>
      </SettingsRow>
      {BUILT_INS.map((b) => {
        const built = page?.builtIns.find((x) => x.kind === b.kind);
        return (
          <SettingsRow
            key={b.kind}
            label={
              <Tiled
                tile={
                  "icon" in b ? (
                    <IconTile icon={b.icon} />
                  ) : (
                    <IconTile letter={b.letter} />
                  )
                }
              >
                {b.label}
              </Tiled>
            }
          >
            {known && built ? (
              <StatusPill tone={built.configured ? "success" : "neutral"}>
                {built.configured ? "On" : "Not set up"}
              </StatusPill>
            ) : (
              <span className="text-sm text-fg-muted">
                {canPlatform && q.isPending ? "Loading" : "Set by the platform"}
              </span>
            )}
          </SettingsRow>
        );
      })}
      <SettingsRow
        label={
          <Tiled tile={<IconTile icon={Building2} />}>Single sign-on</Tiled>
        }
        help={sso}
      >
        {known ? (
          <Link to={r.platformConnections()} className={linkClass}>
            Connections
            <ArrowRight className="ml-1 inline size-4" aria-hidden />
          </Link>
        ) : null}
      </SettingsRow>
      {settings.data?.appReview48Warning ? (
        <div className="px-5 py-4">
          <Callout tone="warning" title="App Review guideline 4.8">
            iPhone and iPad devices use this app, and it has no native Sign in
            with Apple of its own. Apple on this card does not count for an iOS
            app that offers another sign-in.
          </Callout>
        </div>
      ) : null}
    </SettingsSection>
  );
}

/** Terms: Polaris Key's are the platform's; the product's version comes from the manifest. */
export function TermsSection({
  slug,
  name,
}: {
  slug: string;
  name: string;
}): React.ReactElement {
  const area = "identity.signIn";
  const q = useQuery({
    queryKey: qk.productSettings(slug, area),
    queryFn: () => api.productSettings(slug, area),
  });
  const value = q.data?.settings.find((s) => s.key === "identity.terms")
    ?.value as { version?: string; url?: string } | null | undefined;
  return (
    <SettingsSection id="terms" title="Terms">
      <SettingsRow
        label="Polaris Key’s Terms and Privacy Policy"
        help="Once per account"
      >
        <span className="text-sm text-fg-muted">Set by the platform</span>
      </SettingsRow>
      {q.isError ? (
        <div className="px-5 py-4">
          <ErrorState
            error={q.error}
            onRetry={() => void q.refetch()}
            compact
          />
        </div>
      ) : (
        <SettingsRow
          label={
            <>
              {name}’s terms
              {value?.version ? (
                <span className="ml-2 text-xs font-normal text-fg-muted">
                  {value.version}
                </span>
              ) : null}
            </>
          }
          help={
            q.isPending
              ? undefined
              : value?.version
                ? "Players accept again when the version changes."
                : "None. Set identity.terms in .pkey/product."
          }
        >
          <span className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1">
            {value?.url ? (
              <a
                className={linkClass}
                href={value.url}
                target="_blank"
                rel="noreferrer"
              >
                View
                <span className="sr-only"> (opens a new tab)</span>
              </a>
            ) : null}
            <Link to={r.listing(slug)} className={linkClass}>
              Edit listing
              <ArrowRight className="ml-1 inline size-4" aria-hidden />
            </Link>
          </span>
        </SettingsRow>
      )}
    </SettingsSection>
  );
}

/** Presentation is Core's: read-only here. */
export function PresentationSection({
  slug,
  product,
}: {
  slug: string;
  product: ProductDetail | undefined;
}): React.ReactElement {
  const accent = product?.presentation?.accent ?? null;
  const name = product?.name ?? slug;
  return (
    <SettingsSection
      id="presentation"
      title="Presentation"
      actions={
        <Link to={r.presentation(slug)} className={cn(linkClass, "text-sm")}>
          Edit in Settings
          <ArrowRight className="ml-1 inline size-4" aria-hidden />
        </Link>
      }
    >
      <SettingsRow
        label={
          <Tiled
            tile={
              <ProductLogo
                name={name}
                presentation={product?.presentation}
                size={32}
              />
            }
          >
            {name}
          </Tiled>
        }
        help={slug}
      >
        {accent ? (
          <span className="inline-flex items-center gap-2 text-sm">
            <span
              aria-hidden
              className="size-4 rounded-full border border-border"
              style={{ background: accent }}
            />
            Accent
            <span className="font-mono text-xs">{accent}</span>
          </span>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}
