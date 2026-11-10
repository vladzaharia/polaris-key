/**
 * Register or edit a client (I-21.14): one drawer, two modes. Creating needs a fresh sign-in; the
 * entries survive the sign-in (`useStepUpDraft`). Editing sends only what changed. The key is the
 * client's name in `.pkey/product` and cannot change once the client exists.
 */

import * as React from "react";
import { HttpError } from "../../../../api.js";
import type { IdentityClient } from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { Checkbox } from "../../../../ui/Checkbox.js";
import { useDismissGuard } from "../../../../ui/Dialog.js";
import { Drawer, DrawerBody, DrawerFooter } from "../../../../ui/Drawer.js";
import {
  Form,
  FormField,
  useAdminForm,
  useFormContext,
} from "../../../../ui/form.js";
import { Input } from "../../../../ui/Input.js";
import { RadioCards } from "../../../../ui/RadioCards.js";
import { Textarea } from "../../../../ui/Textarea.js";
import { toast } from "../../../../ui/toast.js";
import { StepUpNotice, useStepUpDraft } from "../../../../ui/useStepUpDraft.js";
import { mutate } from "../../../data/mutations.js";
import {
  bodyOf,
  claimsDelivered,
  CLAIMS,
  EMPTY_CLIENT,
  FIELD_ORDER,
  keyFromName,
  refusalCopy,
  SCOPES,
  TYPE_HELP,
  TYPE_LABEL,
  validateClient,
  valuesOf,
  type ClientValues,
} from "./model.js";

/** One draft per drawer: registering, or editing one client. */
const STEP_UP_KEY = (slug: string, client?: IdentityClient) =>
  client ? `identity-client:${slug}:${client.id}` : `identity-client:${slug}`;

export function ClientDrawer({
  slug,
  client,
  open,
  onOpenChange,
  onCreated,
}: {
  slug: string;
  /** Absent: register a new client. */
  client?: IdentityClient;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (client: IdentityClient) => void;
}): React.ReactElement {
  const creating = client === undefined;
  const stepUp = useStepUpDraft(STEP_UP_KEY(slug, client), open, () =>
    onOpenChange(true),
  );
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title={creating ? "Register a client" : `Edit ${client.name}`}
      description={
        creating
          ? "A website or app that signs people in with this product."
          : undefined
      }
      size="lg"
    >
      {open ? (
        <ClientFormBody
          slug={slug}
          client={client}
          stepUp={stepUp}
          onDone={() => onOpenChange(false)}
          onCreated={onCreated}
        />
      ) : null}
    </Drawer>
  );
}

function ClientFormBody({
  slug,
  client,
  stepUp,
  onDone,
  onCreated,
}: {
  slug: string;
  client?: IdentityClient;
  stepUp: ReturnType<typeof useStepUpDraft>;
  onDone: () => void;
  onCreated?: (client: IdentityClient) => void;
}): React.ReactElement {
  const creating = client === undefined;
  const start = React.useMemo<ClientValues>(() => {
    const base = client ? valuesOf(client) : EMPTY_CLIENT;
    const saved = stepUp.take();
    if (saved?.values) {
      try {
        return { ...base, ...(JSON.parse(saved.values) as ClientValues) };
      } catch {
        return base;
      }
    }
    return base;
    // Read once, when the drawer opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const form = useAdminForm<ClientValues>({
    values: start,
    validate: (v) => validateClient(v, { creating }),
    mapServerErrors: (e) => {
      if (!(e instanceof HttpError) || !e.fields?.length) return null;
      const body = (e.body ?? {}) as {
        messages?: Record<string, string>;
        reasons?: Record<string, string>;
      };
      // In the order the form reads, so focus lands on the first field to fix.
      const fields = [...e.fields].sort((a, b) => rank(a) - rank(b));
      return Object.fromEntries(
        fields.map((f) => [
          f,
          refusalCopy(f, body.reasons?.[f] ?? e.reason, body.messages?.[f]),
        ]),
      );
    },
    onSubmit: async (v) => {
      if (stepUp.needed) {
        stepUp.signIn({ values: JSON.stringify(v) });
        return;
      }
      try {
        if (creating) {
          const res = await mutate(
            "createIdentityClient",
            slug,
            bodyOf(v, true),
          );
          toast.success("Client registered", { description: v.name.trim() });
          onDone();
          onCreated?.(res.client);
        } else {
          const body = bodyOf(v, false, valuesOf(client));
          if (Object.keys(body).length === 0) {
            onDone();
            return;
          }
          await mutate("updateIdentityClient", slug, client.id, body);
          toast.success("Client saved");
          onDone();
        }
      } catch (e) {
        if (stepUp.check(e)) return;
        throw e;
      }
    },
  });
  const failure =
    form.submitError &&
    !(
      form.submitError instanceof HttpError && form.submitError.fields?.length
    ) &&
    !stepUp.needed
      ? form.submitError
      : null;
  return (
    <Form
      form={form}
      aria-label={creating ? "Register a client" : "Edit client"}
      className="flex min-h-0 flex-1 flex-col"
    >
      <DrawerBody className="space-y-5">
        {stepUp.needed ? (
          <Notice>
            <StepUpNotice />
          </Notice>
        ) : null}
        {failure ? (
          <Notice>
            <Callout tone="danger" title="The client wasn't saved" live>
              {form.submitError instanceof HttpError &&
              form.submitError.reason === "client_limit"
                ? "A product has at most 20 clients. Delete one first."
                : form.submitError instanceof HttpError &&
                    form.submitError.reason === "issuer_off"
                  ? "Turn on Sign in with this product first."
                  : errorCopy(failure, { thing: "Client" }).description}
            </Callout>
          </Notice>
        ) : null}
        <ClientFields
          creating={creating}
          keyTyped={start.key !== "" && start.key !== keyFromName(start.name)}
        />
      </DrawerBody>
      <DrawerFooter>
        <Button
          variant="ghost"
          type="button"
          onClick={onDone}
          disabled={form.isSubmitting}
        >
          Cancel
        </Button>
        <Button type="submit" loading={form.isSubmitting}>
          {stepUp.needed
            ? "Sign in again"
            : creating
              ? "Register client"
              : "Save"}
        </Button>
      </DrawerFooter>
    </Form>
  );
}

/** A refusal above the fields: scrolled into view when it appears, so the reason is not off-screen. */
function Notice({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    ref.current?.scrollIntoView?.({ block: "nearest" });
  }, []);
  return <div ref={ref}>{children}</div>;
}

const rank = (f: string): number => {
  const i = (FIELD_ORDER as readonly string[]).indexOf(f);
  return i === -1 ? FIELD_ORDER.length : i;
};

function ClientFields({
  creating,
  keyTyped,
}: {
  creating: boolean;
  /** The key came back from a step-up with a value the person typed: the name no longer drives it. */
  keyTyped: boolean;
}): React.ReactElement {
  const form = useFormContext<ClientValues>();
  useDismissGuard(!!form?.isDirty && !form.isSubmitting);
  const watch = form!.rhf.watch;
  const scopes = watch("scopes");
  const type = watch("type");
  const delivered = claimsDelivered(scopes);
  // A key follows the name until the person edits it.
  const keyTouched = React.useRef(keyTyped);
  const name = watch("name");
  React.useEffect(() => {
    if (creating && !keyTouched.current)
      form!.rhf.setValue("key", keyFromName(name));
  }, [creating, name, form]);
  return (
    <div className="grid gap-5">
      <FormField
        name="name"
        label="Name"
        required
        help="People see this name when they sign in."
      >
        {(f) => (
          <Input
            {...f}
            autoFocus
            maxLength={64}
            placeholder="e.g. Community forum"
          />
        )}
      </FormField>
      <FormField
        name="key"
        label="Key"
        required={creating}
        help={
          creating
            ? "How your .pkey/product file refers to the client. It can't change later."
            : "Fixed when the client was registered."
        }
      >
        {(f) => (
          <Input
            {...f}
            mono
            readOnly={!creating}
            onChange={(e) => {
              keyTouched.current = true;
              f.onChange(e);
            }}
          />
        )}
      </FormField>
      <FormField name="type" label="Type" group>
        {(f) => (
          <RadioCards<string>
            {...f}
            columns={1}
            options={(["web", "spa", "native"] as const).map((t) => ({
              value: t,
              label: TYPE_LABEL[t],
              description: TYPE_HELP[t],
            }))}
          />
        )}
      </FormField>
      <FormField
        name="redirectUris"
        label="Redirect addresses"
        required
        help={
          type === "native"
            ? "One per line. https, a loopback address (http://127.0.0.1/callback, no port) or your reverse-DNS scheme."
            : "One per line. https only. People return to one of these after signing in."
        }
      >
        {(f) => (
          <Textarea
            {...f}
            rows={3}
            spellCheck={false}
            className="font-mono"
            placeholder="https://forum.example.com/auth/callback"
          />
        )}
      </FormField>
      <FormField
        name="postLogoutRedirectUris"
        label="Sign-out addresses"
        optional
        help="One per line. Where people may land after signing out of the client."
      >
        {(f) => (
          <Textarea {...f} rows={2} spellCheck={false} className="font-mono" />
        )}
      </FormField>
      <FormField
        name="scopes"
        label="What the client gets"
        group
        help="People can still decline the optional items on the sign-in card."
      >
        {(f) => (
          <div className="space-y-2">
            {SCOPES.map((s) => (
              <Checkbox
                key={s.id}
                label={s.label}
                description={s.help}
                disabled={s.id === "openid"}
                checked={(f.value as string[]).includes(s.id)}
                onCheckedChange={(on) => {
                  const cur = f.value as string[];
                  f.onChange(
                    on ? [...cur, s.id] : cur.filter((x) => x !== s.id),
                  );
                }}
              />
            ))}
          </div>
        )}
      </FormField>
      <FormField
        name="claimsRequired"
        label="Always shared"
        group
        help="People can't switch these off. Declining means canceling the sign-in."
      >
        {(f) => (
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {CLAIMS.map((c) => (
              <Checkbox
                key={c.id}
                label={c.label}
                disabled={!delivered.includes(c.id)}
                checked={
                  (f.value as string[]).includes(c.id) &&
                  delivered.includes(c.id)
                }
                onCheckedChange={(on) => {
                  const cur = f.value as string[];
                  f.onChange(
                    on ? [...cur, c.id] : cur.filter((x) => x !== c.id),
                  );
                }}
              />
            ))}
          </div>
        )}
      </FormField>
      <FormField
        name="developerName"
        label="Developer"
        optional
        help="Leave blank for your own apps. Another company's client names its developer: people see “by <developer>”, and it recognizes them as your apps do."
      >
        {(f) => (
          <Input {...f} maxLength={64} placeholder="Example Partner Ltd" />
        )}
      </FormField>
    </div>
  );
}
