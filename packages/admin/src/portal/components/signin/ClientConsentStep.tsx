import * as React from "react";
import { Lock, ShieldCheck } from "lucide-react";
import type { AppConsentView } from "@polaris-key/protocol/identity";
import { Button } from "../../../ui/Button.js";
import { Switch } from "../../../ui/Switch.js";
import {
  AUTH_METHOD_CLASS,
  AuthNotice,
  AuthTitle,
} from "../../../ui/auth/index.js";
import { t } from "../../../lib/copy.js";
import {
  clientLines,
  sharedPhrase,
  type ClientLine,
} from "../../model/signInRequest.js";
import {
  ConsentFoot,
  ConsentHead,
  PersonRow,
  PRIMARY_CLASS,
  RequestGone,
} from "./requestParts.js";
import { useTermsCheck } from "./TermsCheck.js";
import { CLIENT_GLYPH as GLYPH } from "./clientGets.js";

/** One item of what the client asks for: its glyph, its words (and value), then a switch or the lock. */
function ClientRow({
  line,
  person,
  on,
  onToggle,
}: {
  line: ClientLine;
  person: AppConsentView["person"];
  on: boolean;
  onToggle: () => void;
}): React.ReactElement {
  const id = React.useId();
  const Glyph = GLYPH[line.id];
  const value = line.id === "name" ? person.displayName : null;
  const switched = line.claim && !line.required;
  const body = (
    <>
      {line.id === "picture" && person.avatarUrl ? (
        <img
          src={person.avatarUrl}
          alt=""
          className="size-6 shrink-0 rounded-full object-cover"
        />
      ) : (
        <Glyph aria-hidden className="size-5 shrink-0 text-fg-muted" />
      )}
      <span className="min-w-[9ch] flex-[1_1_9ch] [overflow-wrap:anywhere]">
        {line.text}
        {value ? (
          <span className="block text-sm/5 text-fg-muted">{value}</span>
        ) : null}
      </span>
      {switched ? (
        <Switch
          id={id}
          touch
          checked={on}
          onCheckedChange={onToggle}
          aria-label={line.label}
        />
      ) : (
        <span className="inline-flex shrink-0 items-center gap-1 text-sm/5 text-fg-muted">
          <Lock aria-hidden className="size-4" />
          {t("locker.issuer.required")}
        </span>
      )}
    </>
  );
  const row = "flex min-h-12 items-center gap-x-3 px-4 py-3 text-fg";
  return (
    <li>
      {switched ? (
        <label htmlFor={id} className={row}>
          {body}
        </label>
      ) : (
        <div className={row}>{body}</div>
      )}
    </li>
  );
}

/**
 * ConsentStep for a registered client (Sign in with <Product>; V5 §12.13.3, §12.13.6). "Continue to
 * <Client> as <first name>?", then what the client asks for, one row each with its own glyph (the
 * screen name and the picture show what they are): a switch on each optional claim (the whole row
 * is its label), the lock and "Required" on every row the person cannot switch off. Only what is
 * undecided is listed; what the client already gets is one quiet line, and what the person declined
 * is never listed again. A partner client's note says another company makes it. The product's terms,
 * when unaccepted, are one check above Continue. **Continue** and **Don't allow** are the same
 * width and height; declining a required claim is Don't allow. The grant is the Worker's: this only
 * posts the claims switched on.
 */
export function ClientConsentStep({
  view,
  app,
  product,
  partner,
  busy,
  error,
  onContinue,
  onDeny,
  onNotYou,
}: {
  view: AppConsentView;
  app: string;
  product: string;
  /** The developer's name when another company makes the client (D8), else null. */
  partner: string | null;
  busy: "continue" | "deny" | null;
  error: string | null;
  /** The claims switched on, to post as `consent.claims`, and the terms version shown, if any. */
  onContinue: (claims: string[], terms?: string) => void;
  onDeny: () => void;
  onNotYou: () => void;
}): React.ReactElement {
  const lines = clientLines(view, app, product);
  const [off, setOff] = React.useState<ReadonlySet<string>>(
    () => new Set(lines.filter((l) => l.startsOff).map((l) => l.id)),
  );
  const terms = useTermsCheck(view.terms, product);
  const toggle = (id: string): void =>
    setOff((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const claims = lines
    .filter((l) => l.claim && !off.has(l.id))
    .map((l) => l.id);
  const shared = view.shared ?? [];
  const go = (): void => {
    if (terms.pass()) onContinue(claims, terms.version);
  };
  return (
    <>
      <ConsentHead person={view.person} app={app} onNotYou={onNotYou} />
      {lines.length > 0 ? (
        <section className="space-y-2" aria-labelledby="pk-client-gets">
          <h2
            id="pk-client-gets"
            className="text-sm/5 font-medium text-fg-strong"
          >
            {t("locker.issuer.gets", { app })}
          </h2>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {lines.map((line) => (
              <ClientRow
                key={line.id}
                line={line}
                person={view.person}
                on={!off.has(line.id)}
                onToggle={() => toggle(line.id)}
              />
            ))}
          </ul>
        </section>
      ) : null}
      {shared.length > 0 ? (
        <p className="text-sm/5 text-fg-muted">
          {t("locker.issuer.shared", { app })} {sharedPhrase(shared)}
        </p>
      ) : null}
      <p className="flex items-start gap-2 text-sm/5 text-fg-muted">
        <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
        {partner
          ? t("locker.issuer.partner", { app, developer: partner, product })
          : t("locker.issuer.sameForAll", { product })}
      </p>
      <ConsentFoot
        terms={terms.check}
        error={error}
        app={app}
        busy={busy}
        onContinue={go}
        onDeny={onDeny}
      />
    </>
  );
}

/**
 * A step before consent that asks the person to act on the session: the client asked for a fresh
 * sign-in (`prompt=login`, or a sign-in older than `max_age`; "Confirm it's you"), or named another
 * account than the one signed in ("<Client> is expecting another account"). Either way the primary
 * ends this Locker session so the card's sign-in comes back; **Don't allow** returns `access_denied`.
 */
export function SessionStep({
  person,
  title,
  body,
  button,
  busy,
  onPrimary,
  onDeny,
}: {
  person: AppConsentView["person"];
  title: string;
  body: string;
  button: string;
  busy: boolean;
  onPrimary: () => void;
  onDeny: () => void;
}): React.ReactElement {
  return (
    <>
      <PersonRow
        name={person.displayName}
        email={person.email}
        picture={person.avatarUrl}
      />
      <div className="space-y-2">
        <AuthTitle>{title}</AuthTitle>
        <p className="text-fg-muted">{body}</p>
      </div>
      <div className="space-y-3">
        <Button
          variant="neutral"
          size="xl"
          className={PRIMARY_CLASS}
          loading={busy}
          onClick={onPrimary}
        >
          {button}
        </Button>
        <Button
          variant="outline"
          size="xl"
          className={AUTH_METHOD_CLASS}
          onClick={onDeny}
        >
          {t("signin.consent.deny")}
        </Button>
      </div>
    </>
  );
}

/** The request can no longer be completed (the client was switched off after the card loaded). */
export function ClientEnded({ app }: { app: string }): React.ReactElement {
  return (
    <RequestGone
      title={t("locker.issuer.ended.title", { app })}
      body={t("locker.issuer.ended.body", { app })}
    />
  );
}
