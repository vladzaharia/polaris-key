/**
 * Product → App sign-in (I-29; identity.app-sign-in): the one page where a product's sign-in is
 * set, replacing Identity → Portal and Identity → Sign-in. Customers sign in on Polaris Locker;
 * this page says what the app's card offers and what the app asks of them.
 *
 * The four per-product toggles (OIDC, magic link, key claim, auto-link) and the Downloads switch
 * are gone: email and passkeys are always on, single sign-on follows the platform's connections,
 * and a domain's owner turns the email methods off with an enforced domain (Platform →
 * Connections). What is left to save is the Customer portal's two switches, one resource, so one
 * form and one SaveBar. License keys are the settings hub's own rows (source, claim, revert).
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../../api.js";
import { fromSeconds } from "../../../../lib/format.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Form, useAdminForm } from "../../../../ui/form.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { SaveBar } from "../../../../ui/SaveBar.js";
import { PageSkeleton } from "../../../../ui/Skeleton.js";
import { Switch } from "../../../../ui/Switch.js";
import { toast } from "../../../../ui/toast.js";
import { useUnsavedChangesGuard } from "../../../../ui/useUnsavedChangesGuard.js";
import { ProductSettingsSection } from "../../../components/ProductSettingsSection.js";
import { useProduct } from "../../../data/hooks.js";
import { mutate } from "../../../data/mutations.js";
import { qk } from "../../../data/queries.js";
import {
  SettingsRow,
  SettingsSection,
  SettingsTemplate,
} from "../../../templates/Settings.js";
import {
  MethodsSection,
  PresentationSection,
  ProductConnectionSection,
  StatusSection,
  TermsSection,
} from "../components/SignInSections.js";
import { Timestamp } from "../../../../ui/Timestamp.js";

type PortalDraft = { portalEnabled: boolean; keyReissueEnabled: boolean };

const TIER_SYNC_COPY = {
  "identity.oidc.syncTierOnSignIn": {
    values: { off: "Off", upgradeOnly: "Upgrade only" },
    consequences: (to: unknown) =>
      to === "upgradeOnly"
        ? [
            "A sign-in may move a licence up to the tier its groups map to; it never moves one down.",
          ]
        : ["A sign-in never changes a licence's tier."],
  },
};

const SECTIONS = [
  { id: "status", title: "Status" },
  { id: "methods", title: "Sign-in methods" },
  { id: "product-connection", title: "Product connection" },
  { id: "tier-sync", title: "Tier sync" },
  { id: "terms", title: "Terms" },
  { id: "license-keys", title: "License keys" },
  { id: "customer-portal", title: "Customer portal" },
  { id: "presentation", title: "Presentation" },
];

export function AppSignInPage({ slug }: { slug: string }): React.ReactElement {
  const product = useProduct(slug);
  const services = useQuery({
    queryKey: qk.services(slug),
    queryFn: () => api.services(slug),
  });
  const portal = useQuery({
    queryKey: qk.portal(slug),
    queryFn: () => api.portalSettings(slug).then((r) => r.settings),
  });
  const mint = useQuery({
    queryKey: qk.mint(slug),
    queryFn: () => api.edgeMintRecipes(slug),
  });
  const name = product.data?.name ?? slug;
  const header = (
    <PageHeader
      title="App sign-in"
      refetching={portal.isFetching && !portal.isPending}
    />
  );

  const failed = services.error ?? portal.error ?? mint.error;
  if (services.isPending || portal.isPending || mint.isPending)
    return (
      <div className="space-y-6">
        {header}
        <PageSkeleton template="form" label="App sign-in" />
      </div>
    );
  if (failed || !services.data || !portal.data || !mint.data)
    return (
      <div className="space-y-6">
        {header}
        <ErrorState
          error={failed}
          onRetry={() => {
            void services.refetch();
            void portal.refetch();
            void mint.refetch();
          }}
        />
      </div>
    );

  const on = services.data.services.identity?.enabled === true;
  if (!on)
    return (
      <SettingsTemplate header={header} sections={[]}>
        <StatusSection slug={slug} name={name} enabled={false} />
        <EmptyState
          kind="service-off"
          service="identity"
          headingLevel={2}
          title="Sign-in is off for this product"
          description="No one can sign in to this app until Sign-in is on."
        />
      </SettingsTemplate>
    );

  return (
    <SettingsTemplate header={header} sections={SECTIONS} jump>
      <StatusSection slug={slug} name={name} enabled />
      <MethodsSection slug={slug} />
      <ProductConnectionSection
        slug={slug}
        name={name}
        product={product.data}
        oidcDefault={mint.data.oidcDefault}
        identity={
          mint.data.identity ?? {
            provider: null,
            issuer: null,
            clientId: null,
            groupRoleMapJson: null,
          }
        }
      />
      <ProductSettingsSection
        slug={slug}
        area="identity.signIn"
        keys={["identity.oidc.syncTierOnSignIn"]}
        id="tier-sync"
        title="Tier sync"
        copy={TIER_SYNC_COPY}
      />
      <TermsSection slug={slug} name={name} />
      <ProductSettingsSection
        slug={slug}
        area="identity.keyEntry"
        id="license-keys"
        title="License keys"
      />
      <PortalCard
        slug={slug}
        name={name}
        settings={portal.data}
        onDone={() => void portal.refetch()}
      />
      <PresentationSection slug={slug} product={product.data} />
    </SettingsTemplate>
  );
}

/** Customer portal: the two switches that remain. One resource, one SaveBar. */
function PortalCard({
  slug,
  name,
  settings,
}: {
  slug: string;
  name: string;
  settings: {
    portalEnabled: boolean;
    keyReissueEnabled?: boolean;
    modifiedAt?: number;
  };
  onDone: () => void;
}): React.ReactElement {
  const form = useAdminForm<PortalDraft>({
    values: {
      portalEnabled: settings.portalEnabled,
      keyReissueEnabled: settings.keyReissueEnabled ?? false,
    },
    onSubmit: async (draft) => {
      try {
        await mutate("updatePortalSettings", slug, draft);
      } catch (err) {
        toast.error(err);
        throw err;
      }
      toast.success("Customer portal saved");
    },
    mapServerErrors: () => null,
  });
  const guard = useUnsavedChangesGuard(form.isDirty, {
    message: "Discard unsaved App sign-in changes?",
    onDiscard: form.discard,
  });
  const values = form.rhf.watch();
  const set = (key: keyof PortalDraft, value: boolean): void =>
    form.rhf.setValue(key, value, { shouldDirty: true });
  const words = [
    form.rhf.formState.dirtyFields.portalEnabled
      ? `${name} ${values.portalEnabled ? "shown" : "hidden"} in libraries`
      : null,
    form.rhf.formState.dirtyFields.keyReissueEnabled
      ? `lost key ${values.keyReissueEnabled ? "shown" : "hidden"}`
      : null,
  ].filter(Boolean);

  return (
    <Form form={form} aria-label="Customer portal">
      <SettingsSection id="customer-portal" title="Customer portal">
        <SettingsRow
          label={`Show ${name} in players’ libraries`}
          htmlFor="portal-libraries"
        >
          <Switch
            id="portal-libraries"
            checked={values.portalEnabled}
            readOnly={form.isSubmitting}
            onCheckedChange={(c) => set("portalEnabled", c)}
          />
        </SettingsRow>
        <SettingsRow label="Show a lost key again" htmlFor="portal-reissue">
          <Switch
            id="portal-reissue"
            checked={values.keyReissueEnabled}
            readOnly={form.isSubmitting}
            onCheckedChange={(c) => set("keyReissueEnabled", c)}
          />
        </SettingsRow>
      </SettingsSection>
      <SaveBar
        form={form}
        saveLabel={`Save ${words.length || ""} change${words.length === 1 ? "" : "s"}`.replace(
          "Save  ",
          "Save ",
        )}
        summary={`${words.length} change${words.length === 1 ? "" : "s"}: ${words.join(", ")}`}
      />
      {guard.dialog}
    </Form>
  );
}
