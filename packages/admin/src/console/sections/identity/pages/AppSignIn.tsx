/**
 * Product → App sign-in (I-29; identity.app-sign-in): the one page where a product's sign-in is
 * set, replacing Identity → Portal and Identity → Sign-in. Customers sign in on Polaris Locker;
 * this page says what the app's card offers and what the app asks of them.
 *
 * The four per-product toggles (OIDC, magic link, key claim, auto-link) and the Downloads switch
 * are gone: email and passkeys are always on, single sign-on follows the platform's connections,
 * and a domain's owner turns the email methods off with an enforced domain (Platform →
 * Connections). What is left to save is one resource set, so one form and one SaveBar: License
 * keys and Polaris Locker. Status applies on its own and Tier sync keeps the settings engine's
 * row (its own confirmation and reason).
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { HttpError, type ProductSetting } from "../../../../api.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { useAdminForm } from "../../../../ui/form.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { SaveBar } from "../../../../ui/SaveBar.js";
import { PageSkeleton } from "../../../../ui/Skeleton.js";
import { toast } from "../../../../ui/toast.js";
import { useUnsavedChangesGuard } from "../../../../ui/useUnsavedChangesGuard.js";
import { useWriteGate } from "../../../access/useCan.js";
import { ProductSettingsSection } from "../../../components/ProductSettingsSection.js";
import { useProduct } from "../../../data/hooks.js";
import { mutate } from "../../../data/mutations.js";
import { reads } from "../../../data/reads.js";
import { mintQuery } from "../../config/data.js";
import { coreBReads } from "../../core/data.js";
import {
  ProductConnectionSection,
  type ConnectionState,
} from "../components/ProductConnection.js";
import { SignInRail } from "../components/SignInRail.js";
import {
  LicenseKeysSection,
  LockerSection,
  type SignInDraft,
} from "../components/SignInKeys.js";
import {
  PlatformSignInSection,
  usePlatformSignInVisible,
} from "../components/PlatformSignIn.js";
import {
  MethodsSection,
  PresentationSection,
  StatusSection,
  TermsSection,
} from "../components/SignInSections.js";

const TIER_SYNC_COPY = {
  "identity.oidc.syncTierOnSignIn": {
    values: { off: "Off", upgradeOnly: "Upgrade only" },
    consequences: (to: unknown) =>
      to === "upgradeOnly"
        ? [
            "A sign-in may move a license up to the tier its groups map to; it never moves one down.",
          ]
        : ["A sign-in never changes a license's tier."],
  },
};

const LIMIT_KEY = "identity.keyEntry.limit";
const TIER_AREA = "identity.signIn";
const TIER_KEY = "identity.oidc.syncTierOnSignIn";

/** The save summary's words for the lost-key switch (hidden until G7, so tested here). */
export function lostKeyWords(on: boolean): string {
  return `lost-key replacement ${on ? "on" : "off"}`;
}

/** A row of the settings engine in the subtree has an unsaved edit (`data-state="changed"`). */
function useRowsDirty(ref: React.RefObject<HTMLElement | null>): boolean {
  const [dirty, setDirty] = React.useState(false);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = (): void =>
      setDirty(el.querySelector('[data-state="changed"]') !== null);
    const mo = new MutationObserver(read);
    mo.observe(el, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-state"],
    });
    read();
    return () => mo.disconnect();
  }, [ref]);
  return dirty;
}

/**
 * The Tier sync section draws nothing when the area has no such row (a view that cannot read it,
 * the service off): the rail then does not list it either.
 */
function useHasTierSync(slug: string): boolean {
  const area = TIER_AREA;
  const tier = useQuery(reads.productSettings(slug, area));
  return tier.data
    ? tier.data.settings.some(
        (st) =>
          st.key === TIER_KEY &&
          (st.visibleWhen?.offBehaviour !== "hide" || st.serviceEnabled),
      )
    : true;
}

export function AppSignInPage({ slug }: { slug: string }): React.ReactElement {
  const product = useProduct(slug);
  const services = useQuery(coreBReads.services(slug));
  const portal = useQuery(coreBReads.portal(slug));
  // Managed config access is a different area: without it this card says so and the rest renders.
  const mint = useQuery({ ...mintQuery(slug), retry: false });
  const area = "identity.keyEntry";
  const keys = useQuery(reads.productSettings(slug, area));
  const hasTierSync = useHasTierSync(slug);
  const hasPlatform = usePlatformSignInVisible(slug);
  const name = product.data?.name ?? slug;
  const header = (
    <PageHeader
      title="App sign-in"
      refetching={portal.isFetching && !portal.isPending}
    />
  );

  const failed = services.error ?? portal.error;
  if (services.isPending || portal.isPending)
    return (
      <div className="space-y-6">
        {header}
        <PageSkeleton template="form" label="App sign-in" />
      </div>
    );
  if (failed || !services.data || !portal.data)
    return (
      <div className="space-y-6">
        {header}
        <ErrorState
          error={failed}
          onRetry={() => {
            void services.refetch();
            void portal.refetch();
          }}
        />
      </div>
    );

  const connection: ConnectionState = mint.isPending
    ? { kind: "loading" }
    : mint.isError
      ? mint.error instanceof HttpError && mint.error.status === 403
        ? { kind: "no-access" }
        : { kind: "error", error: mint.error, retry: () => void mint.refetch() }
      : {
          kind: "ready",
          identity: mint.data.identity,
          oidcDefault: mint.data.oidcDefault,
        };

  return (
    <PageBody
      slug={slug}
      name={name}
      header={header}
      product={product.data}
      connection={connection}
      portal={portal.data}
      limit={keys.data?.settings.find((s) => s.key === LIMIT_KEY)}
      claimByKey={portal.data.claimByKey ?? false}
      hasTierSync={hasTierSync}
      hasPlatform={hasPlatform}
    />
  );
}

function PageBody({
  slug,
  name,
  header,
  product,
  connection,
  portal,
  limit,
  claimByKey,
  hasTierSync,
  hasPlatform,
}: {
  slug: string;
  name: string;
  header: React.ReactNode;
  product: ReturnType<typeof useProduct>["data"];
  connection: ConnectionState;
  portal: { portalEnabled: boolean; keyReissueEnabled?: boolean };
  limit: ProductSetting | undefined;
  claimByKey: boolean;
  hasTierSync: boolean;
  hasPlatform: boolean;
}): React.ReactElement {
  const gate = useWriteGate("signin", slug);
  // The Sign-in switch is a Settings write: the one notice names the access a viewer is missing.
  const settingsGate = useWriteGate("core", slug, "Settings");
  const notice = settingsGate.disabledReason ?? gate.disabledReason;
  const tierRef = React.useRef<HTMLDivElement>(null);
  const tierDirty = useRowsDirty(tierRef);
  const saved: SignInDraft = {
    portalEnabled: portal.portalEnabled,
    keyReissueEnabled: portal.keyReissueEnabled ?? false,
    claimByKey,
    keyLimit: typeof limit?.value === "number" ? limit.value : null,
  };
  const form = useAdminForm<SignInDraft>({
    values: saved,
    onSubmit: async (draft) => {
      let n = 0;
      try {
        const patch: Record<string, boolean> = {};
        for (const k of [
          "portalEnabled",
          "keyReissueEnabled",
          "claimByKey",
        ] as const)
          if (draft[k] !== saved[k]) patch[k] = draft[k];
        if (Object.keys(patch).length > 0) {
          await mutate("updatePortalSettings", slug, patch);
          n += Object.keys(patch).length;
        }
        if (
          limit &&
          draft.keyLimit !== null &&
          draft.keyLimit !== saved.keyLimit
        ) {
          await mutate("updateProductSetting", slug, LIMIT_KEY, {
            value: draft.keyLimit,
            expectedVersion: limit.version,
          });
          n += 1;
        }
      } catch (err) {
        toast.error(err);
        throw err;
      }
      toast.success(`Saved ${n} change${n === 1 ? "" : "s"} to App sign-in`);
    },
    mapServerErrors: () => null,
  });
  const guard = useUnsavedChangesGuard(form.isDirty || tierDirty, {
    message: "Discard unsaved App sign-in changes?",
    onDiscard: form.discard,
  });
  const draft = form.rhf.watch();
  const set = <K extends keyof SignInDraft>(
    key: K,
    value: SignInDraft[K],
  ): void => form.rhf.setValue(key, value as never, { shouldDirty: true });
  const readOnly = !gate.allowed || form.isSubmitting;

  const lockerDirty =
    draft.portalEnabled !== saved.portalEnabled ||
    draft.keyReissueEnabled !== saved.keyReissueEnabled;
  const keysDirty =
    draft.claimByKey !== saved.claimByKey || draft.keyLimit !== saved.keyLimit;
  const words = [
    draft.portalEnabled !== saved.portalEnabled
      ? `${name} ${draft.portalEnabled ? "shown" : "hidden"} in libraries`
      : null,
    draft.keyReissueEnabled !== saved.keyReissueEnabled
      ? lostKeyWords(draft.keyReissueEnabled)
      : null,
    draft.keyLimit !== saved.keyLimit
      ? `key entries ${
          limit?.spec.kind === "integer" && draft.keyLimit === limit.spec.max
            ? "unlimited"
            : draft.keyLimit
        }`
      : null,
    draft.claimByKey !== saved.claimByKey
      ? `key claim ${draft.claimByKey ? "on" : "off"}`
      : null,
  ].filter((w): w is string => w !== null);
  const summary = `${words.length} change${words.length === 1 ? "" : "s"}: ${words.join(", ")}`;

  const sections = [
    { id: "status", title: "Status" },
    { id: "methods", title: "Sign-in methods" },
    { id: "product-connection", title: "Product connection" },
    ...(hasTierSync
      ? [{ id: "tier-sync", title: "Tier sync", dirty: tierDirty }]
      : []),
    ...(hasPlatform
      ? [{ id: "platform-sign-in", title: "Platform sign-in" }]
      : []),
    { id: "terms", title: "Terms" },
    { id: "license-keys", title: "License keys", dirty: keysDirty },
    { id: "polaris-locker", title: "Polaris Locker", dirty: lockerDirty },
    { id: "presentation", title: "Presentation" },
  ];

  return (
    <div className="@container space-y-6" data-template="settings">
      {header}
      {notice ? (
        <p role="note" className="text-sm text-fg-muted">
          {notice}
        </p>
      ) : null}
      <SignInRail sections={sections} variant="pills" />
      <div className="mx-auto grid w-full max-w-[84rem] grid-cols-1 gap-6 @min-[56rem]:grid-cols-[minmax(0,1fr)_22.5rem]">
        <div className="min-w-0 space-y-6">
          <StatusSection slug={slug} name={name} enabled />
          <MethodsSection slug={slug} />
          <ProductConnectionSection
            slug={slug}
            name={name}
            product={product}
            state={connection}
          />
          <div ref={tierRef}>
            <ProductSettingsSection
              slug={slug}
              area={TIER_AREA}
              keys={[TIER_KEY]}
              id="tier-sync"
              title="Tier sync"
              copy={TIER_SYNC_COPY}
            />
          </div>
          <PlatformSignInSection slug={slug} />
          <TermsSection slug={slug} name={name} />
          <LicenseKeysSection
            slug={slug}
            draft={draft}
            saved={saved}
            limit={limit}
            readOnly={readOnly}
            set={set}
          />
        </div>
        <aside aria-label="About this page" className="min-w-0 space-y-6">
          <SignInRail sections={sections} variant="rail" />
          <LockerSection
            name={name}
            draft={draft}
            saved={saved}
            readOnly={readOnly}
            set={set}
          />
          <PresentationSection slug={slug} product={product} />
        </aside>
      </div>
      <SaveBar
        form={form}
        saveLabel={`Save ${words.length} change${words.length === 1 ? "" : "s"}`}
        summary={
          <span className="block max-w-full truncate" title={summary}>
            {summary}
          </span>
        }
        section="App sign-in"
      />
      {guard.dialog}
    </div>
  );
}
