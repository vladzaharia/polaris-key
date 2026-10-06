// The error copy catalog (SDK-PARITY-PASS §3.2, core.copy): what a kit SAYS for a code, in one
// place.
//
//   copyMessage(code, { locale?, detail?, params? })  the sentence a screen shows
//   copyTitle(code, locale?)                          the short heading above it
//   activationMessage(kind, locale?)                  the sentence for a typed activation result
//   activationTitle(kind, locale?)                    its heading
//   describeError(err, locale?)                       the sentence for a PolarisError: its typed
//                                                     activation result first, then its
//                                                     `wireCode` (the server's code), then its
//                                                     own `code`
//
// ENGLISH IS GENERATED. `../copy.generated.ts` is written by `pnpm gen:constants` from
// `conformance/parity/copy.en.json` (checked against errors.json and enums.json), with three
// tables: COPY_CODES (per error code), COPY_GATE (per licenseStatus) and COPY_ACTIVATION (per
// activationResult). They are separate on purpose: the error code `unauthorized` reads "Not
// signed in", the activation result `unauthorized` reads "Key not accepted". `copyMessage(code)`
// looks a code up as an error code, then as a gate status, then as an activation result;
// `describeError` reads a typed activation result from the activation table only.
//
// A code with no entry falls back to COPY_FALLBACK, which NAMES the code and never shows the raw
// server body: a body is not copy, and it is not localised.
//
// French is the proof locale and stays a hand table until SP-03 generates the locales; more
// locales are content, not code (`registerCopyLocale`). A non-English bundle is keyed by error
// code, gate status and §3.1 activation kind (camelCase, as `ActivationOutcome.kind`), and every
// key it lacks falls back to the generated English.

import {
  COPY_ACTIVATION,
  COPY_CODES,
  COPY_FALLBACK,
  COPY_GATE,
  type CopyEntry,
} from "../copy.generated.js";

/** A locale bundle: code → sentence, and code → title. */
export interface CopyBundle {
  messages: Record<string, string>;
  titles?: Record<string, string>;
  /** The fallback sentence; `{code}` is replaced by the code. */
  generic: string;
}

/** A §3.1 activation kind (`deviceLimit`) as its activationResult (`device-limit`). */
function activationResult(kind: string): string {
  return kind.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** The generated English entry for a code: error code, then gate status, then activation result. */
function englishEntry(code: string): CopyEntry | undefined {
  return (
    ownEntry(COPY_CODES, code) ??
    ownEntry(COPY_GATE, code) ??
    ownEntry(COPY_ACTIVATION, activationResult(code))
  );
}

function ownEntry(
  table: Readonly<Record<string, CopyEntry>>,
  key: string,
): CopyEntry | undefined {
  return Object.prototype.hasOwnProperty.call(table, key)
    ? table[key]
    : undefined;
}

/** English as a bundle. The generated tables above are the default text; this bundle's
 *  `messages` and `titles` are the host's override layer (`registerCopyLocale("en", ...)`),
 *  which wins per key and starts empty. */
const EN: CopyBundle = {
  generic: COPY_FALLBACK.message,
  messages: {},
  titles: {},
};

const FR: CopyBundle = {
  generic: "Une erreur s'est produite ({code}). Veuillez réessayer.",
  titles: {
    deviceLimit: "Limite d'appareils atteinte",
    device_limit: "Limite d'appareils atteinte",
    licenseDisabled: "Licence désactivée",
    license_disabled: "Licence désactivée",
    licenseExpired: "Licence expirée",
    license_expired: "Licence expirée",
    enrollClaimed: "Connectez-vous pour continuer",
    enroll_claimed: "Connectez-vous pour continuer",
    rateLimited: "Trop de tentatives",
    rate_limited: "Trop de tentatives",
    unauthorized: "Clé refusée",
    network: "Vous êtes hors ligne",
    "network-error": "Vous êtes hors ligne",
    attestation_required: "Vérification de l'appareil requise",
    attestationRequired: "Vérification de l'appareil requise",
    "needs-activation": "Activation requise",
    revoked: "Licence révoquée",
    expired: "Licence expirée",
    grace: "Période de grâce hors ligne",
    "version-too-old": "Mise à jour requise",
    "version-too-new": "Version non autorisée",
    "channel-not-entitled": "Canal non inclus",
  },
  messages: {
    deviceLimit:
      "Cette licence a atteint sa limite d'appareils. Libérez un appareil depuis votre compte, puis réessayez.",
    fingerprintRequired:
      "Cette licence exige une vérification d'appareil que cette application ne peut pas fournir ici. Contactez le développeur.",
    hardwareMismatch:
      "Cet appareil a changé depuis son activation. Activez-le à nouveau pour le lier.",
    enrollClaimed:
      "La licence gratuite de cet appareil appartient désormais à un compte. Connectez-vous pour l'utiliser.",
    licenseDisabled:
      "Cette licence a été désactivée. Contactez le vendeur ou votre administrateur.",
    licenseExpired:
      "Cette licence a expiré. Renouvelez-la pour continuer à utiliser l'application.",
    attestationRequired:
      "Ce produit ne fonctionne que sur des appareils vérifiés, et cet appareil n'a pas pu être vérifié.",
    rateLimited: "Trop de tentatives. Patientez un instant, puis réessayez.",
    enrollDisabled:
      "L'activation gratuite n'est pas proposée pour ce produit. Saisissez une clé ou connectez-vous.",
    refused: "Le service de licences a refusé cette demande ({code}).",
    error:
      "Impossible de joindre le service de licences. Vérifiez votre connexion et réessayez.",
    unauthorized:
      "Cette clé ou cette session n'a pas été acceptée. Vérifiez-la et réessayez.",
    not_found: "Cet élément n'existe pas, ou ce produit ne le propose pas.",
    bad_request:
      "La demande n'était pas valide. Mettez l'application à jour et réessayez.",
    forbidden: "Votre licence ne vous permet pas de faire cela.",
    attestation_required:
      "Ce produit ne fonctionne que sur des appareils vérifiés, et cet appareil n'a pas pu être vérifié.",
    attestation_rejected:
      "Cet appareil n'a pas pu être vérifié. Réessayez plus tard.",
    attestation_unavailable:
      "La vérification des appareils n'est pas encore configurée pour ce produit.",
    rate_limited: "Trop de tentatives. Patientez un instant, puis réessayez.",
    body_too_large: "C'était trop volumineux pour être envoyé.",
    method_not_allowed:
      "Cette application a envoyé une demande que le service n'accepte pas. Mettez-la à jour.",
    misconfigured:
      "Ce produit n'est pas encore entièrement configuré. Contactez le développeur.",
    registration_closed:
      "Ce produit exige une clé de licence ou une connexion avant que cet appareil puisse le rejoindre.",
    value_not_representable:
      "Cette valeur ne peut pas être enregistrée. Retirez les caractères inhabituels et réessayez.",
    document_not_representable:
      "La configuration du développeur ne peut pas être livrée pour le moment. Réessayez plus tard.",
    device_limit:
      "Cette licence a atteint sa limite d'appareils. Libérez un appareil depuis votre compte, puis réessayez.",
    license_disabled:
      "Cette licence a été désactivée. Contactez le vendeur ou votre administrateur.",
    license_unusable:
      "Cette licence n'est plus utilisable (désactivée, expirée ou supprimée). Contactez le vendeur ou votre administrateur.",
    license_expired:
      "Cette licence a expiré. Renouvelez-la pour continuer à utiliser l'application.",
    not_entitled: "Votre licence n'inclut pas cela.",
    version_blocked:
      "Cette version de l'application n'est pas autorisée par votre licence. Mettez l'application à jour.",
    channel_not_allowed: "Votre licence n'inclut pas ce canal de publication.",
    hardware_mismatch:
      "Cet appareil a changé depuis son activation. Activez-le à nouveau pour le lier.",
    fingerprint_required:
      "Cette licence exige une vérification d'appareil que cette application ne peut pas fournir ici. Contactez le développeur.",
    enroll_disabled:
      "L'activation gratuite n'est pas proposée pour ce produit. Saisissez une clé ou connectez-vous.",
    enroll_claimed:
      "La licence gratuite de cet appareil appartient désormais à un compte. Connectez-vous pour l'utiliser.",
    enroll_failed:
      "L'activation gratuite n'a pas pu aboutir. Réessayez dans un instant.",
    managed_by_admin: "Votre administrateur gère ce paramètre.",
    catalog_unavailable:
      "Les paramètres ne peuvent pas être livrés pour le moment. Réessayez plus tard.",
    disabled: "La connexion n'est pas configurée pour ce produit.",
    oidc_error:
      "Le fournisseur de connexion n'a pas répondu correctement. Réessayez.",
    unavailable:
      "La connexion est saturée pour le moment. Réessayez dans un instant.",
    identity_disabled:
      "La connexion via cette application est désactivée. Vos installations et licences continuent de fonctionner.",
    auth_method_disabled: "Cette méthode de connexion est désactivée.",
    email_unavailable:
      "La connexion par e-mail n'est pas disponible pour le moment.",
    turnstile_failed:
      "La vérification de sécurité a échoué. Rechargez la page et réessayez.",
    signin_expired: "Cette connexion a expiré. Recommencez.",
    invalid_code:
      "Ce code n'a pas fonctionné. Vérifiez l'e-mail et saisissez-le à nouveau.",
    email_in_use:
      "Un autre compte Polaris Key utilise déjà cette adresse e-mail. Associez cette connexion à ce compte, ou utilisez une autre adresse.",
    terms_required: "Acceptez les conditions pour continuer.",
    license_owned:
      "Cette licence appartient à un autre compte. Connectez-vous avec ce compte.",
    email_mismatch: "Cette licence a été vendue à une autre adresse e-mail.",
    link_conflict:
      "Cette méthode de connexion est déjà liée à un autre compte.",
    last_link: "Vous ne pouvez pas retirer votre seule méthode de connexion.",
    step_up_required: "Reconnectez-vous pour confirmer votre identité.",
    not_eligible: "Cette offre n'est plus disponible.",
    not_removable:
      "Cette licence ne peut pas être ajoutée de nouveau avec une clé : elle reste dans votre bibliothèque.",
    download_auth_required:
      "Connectez-vous ou activez l'application pour télécharger ceci.",
    delivery_gate_missing:
      "Ce téléchargement n'est pas encore disponible. Contactez le développeur.",
    upstream_rate_limited:
      "Les téléchargements sont saturés pour le moment. Réessayez dans un instant.",
    server_misconfigured:
      "Ce produit n'est pas encore entièrement configuré. Contactez le développeur.",
    internal_error:
      "Le service de téléchargement a échoué. Réessayez dans un instant.",
    release_record_rejected: "Cette version n'a pas pu être publiée.",
    release_tag_is_pack_release: "Cette version n'a pas pu être publiée.",
    asset_unreachable:
      "Une image n'a pas pu être récupérée depuis sa source. La copie précédente reste affichée.",
    feed_not_composable:
      "Impossible de vérifier les mises à jour pour le moment. Réessayez plus tard.",
    network:
      "Impossible de joindre le service de licences. Vérifiez votre connexion et réessayez.",
    "network-error":
      "Impossible de joindre le service de licences. Vérifiez votre connexion et réessayez.",
    "server-error":
      "Le service de licences a rencontré un problème. Réessayez dans un instant.",
    timeout:
      "Le service de licences a mis trop de temps à répondre. Réessayez.",
    "service-disabled": "Cette fonction n'est pas activée pour ce produit.",
    "service-unavailable":
      "Cette fonction n'est pas disponible pour ce produit.",
    "key-entry-unsupported":
      "La saisie de clé n'est pas disponible ici. Utilisez plutôt le bouton de connexion.",
    "device-management-unsupported":
      "Cette application ne peut pas gérer les appareils ici. Ouvrez votre compte pour les consulter.",
    "refresh-failed":
      "Impossible d'actualiser votre licence. Réessayez dans un instant.",
    "bridge-missing":
      "Le service de licences n'est pas disponible dans cette application. Réinstallez-la ou contactez l'assistance.",
    "sign-in-failed": "La connexion a échoué. Veuillez réessayer.",
    "sign-in-expired": "Le code de connexion a expiré. Recommencez.",
    "sign-in-denied": "La connexion a été refusée.",
    "sign-in-unavailable":
      "La connexion ne peut pas démarrer pour le moment. Réessayez dans un instant.",
    "sign-out-failed": "Impossible de vous déconnecter. Réessayez.",
    "bundle-rejected":
      "Ce fichier d'activation n'est pas valide pour cet appareil.",
    "bundle-import-unsupported":
      "Cette application ne peut pas importer de fichiers d'activation ici.",
    "bundle-jws-rejected":
      "La signature de ce fichier d'activation n'est pas valide.",
    "bundle-claims-rejected":
      "Ce fichier d'activation est destiné à un autre appareil, ou il a expiré.",
    "bundle-trust-rejected":
      "Ce fichier d'activation n'a pas été émis pour cette application.",
    "inner-doc-rejected":
      "Une partie de ce fichier d'activation n'a pas passé la vérification.",
    "release-refused": "Votre licence n'inclut pas ce téléchargement.",
    "report-unsupported":
      "Cette application ne peut pas envoyer de rapports d'appareil ici.",
    unsupported: "Ce n'est pas pris en charge ici.",
    "no-token": "Activez l'application ou connectez-vous d'abord.",
    "mint-unavailable":
      "Ce jeton de service ne peut pas être émis pour le moment.",
    "not-configured":
      "Cette application n'est pas encore configurée pour cela.",
    "store-failed":
      "Ce navigateur n'a pas pu enregistrer votre connexion. Vérifiez ses paramètres de stockage.",
    cancelled: "Annulé.",
    ok: "Votre licence est active.",
    grace:
      "Le service de licences est hors ligne. Vous pouvez continuer jusqu'à la fin de la période de grâce.",
    expired:
      "Votre licence ou votre période de grâce hors ligne est terminée. Connectez-vous ou activez une clé pour continuer.",
    revoked:
      "Cette licence n'est plus active sur cet appareil. Contactez votre administrateur.",
    "needs-activation":
      "Connectez-vous ou saisissez une clé de licence pour déverrouiller cette application.",
    "version-too-old":
      "Cette version n'est plus prise en charge. Mettez l'application à jour.",
    "version-too-new":
      "Cette version de l'application est plus récente que ce que votre licence autorise.",
    "channel-not-entitled":
      "Votre licence n'inclut pas ce canal de publication. Changez de canal ou contactez votre administrateur.",
    "not-applicable": "Ce produit ne fait pas l'objet d'une licence distincte.",
  },
};

const LOCALES = new Map<string, CopyBundle>([
  ["en", EN],
  ["fr", FR],
]);

/** The locale tags with a bundle, in registration order. */
export function copyLocales(): string[] {
  return [...LOCALES.keys()];
}

/** Add or replace a locale's bundle. Entries missing from it fall back to English. For `en`
 *  the bundle is merged into the host override layer: its keys win over the generated text,
 *  which stays the default for every key the host does not name. */
export function registerCopyLocale(locale: string, bundle: CopyBundle): void {
  const tag = locale.toLowerCase();
  if (tag === "en") {
    Object.assign(EN.messages, bundle.messages);
    Object.assign((EN.titles ??= {}), bundle.titles ?? {});
    // An empty `generic` keeps the generated fallback sentence.
    if (bundle.generic) EN.generic = bundle.generic;
    return;
  }
  LOCALES.set(tag, bundle);
}

/** The bundle for a BCP-47 tag: exact, then its language (`fr-CA` → `fr`), then English. */
function bundleFor(locale?: string): CopyBundle {
  if (!locale) return EN;
  const tag = locale.toLowerCase();
  return LOCALES.get(tag) ?? LOCALES.get(tag.split("-")[0]!) ?? EN;
}

function own(
  map: Record<string, string> | undefined,
  key: string,
): string | undefined {
  return map && Object.prototype.hasOwnProperty.call(map, key)
    ? map[key]
    : undefined;
}

/** Whether a locale has its own sentence for `code` (English: a host override or the
 *  generated tables). */
export function hasCopy(code: string, locale = "en"): boolean {
  const bundle = bundleFor(locale);
  return (
    own(bundle.messages, code) !== undefined ||
    (bundle === EN && englishEntry(code) !== undefined)
  );
}

/** Placeholder values for a sentence (`copy.en.json`'s `{name}` set). */
export type CopyParams = Partial<
  Record<
    | "code"
    | "detail"
    | "limit"
    | "deviceCount"
    | "retryAfterSeconds"
    | "product",
    string | number
  >
>;

/** Fill `{name}` placeholders; `{code}` defaults to the code. An unfilled placeholder is
 *  dropped (with the space before it), so a raw `{name}` never shows. */
function fill(text: string, code: string, params: CopyParams): string {
  return text.replace(/( ?)\{(\w+)\}/g, (_m, space: string, name: string) => {
    const v = (params as Record<string, string | number | undefined>)[name];
    if (v !== undefined) return `${space}${String(v)}`;
    if (name === "code") return `${space}${code}`;
    return "";
  });
}

/**
 * The sentence for `code`. `{code}` in a sentence is replaced by the code (or `codeLabel`), the
 * other placeholders by `params`; `detail` (a refusal's `reason`, for instance) is appended in
 * parentheses when given. An unknown code falls back to the locale's generic sentence naming it,
 * never the server's raw body.
 */
export function copyMessage(
  code: string,
  opts: {
    locale?: string;
    detail?: string;
    codeLabel?: string;
    params?: CopyParams;
  } = {},
): string {
  const bundle = bundleFor(opts.locale);
  const text =
    own(bundle.messages, code) ??
    own(EN.messages, code) ??
    englishEntry(code)?.message ??
    (bundle.generic || EN.generic);
  const out = fill(text, opts.codeLabel ?? code, opts.params ?? {});
  return opts.detail ? `${out} (${opts.detail})` : out;
}

/** The short heading for `code`, or the locale's generic error title. */
export function copyTitle(code: string, locale?: string): string {
  const bundle = bundleFor(locale);
  return (
    own(bundle.titles, code) ??
    own(EN.titles, code) ??
    englishEntry(code)?.title ??
    (bundle === FR ? "Une erreur s'est produite" : COPY_FALLBACK.title)
  );
}

/** A typed activation result's entry for a locale: the bundle's own (keyed by the §3.1 kind),
 *  else the generated activation table — never the error-code table. */
function activationText(
  kind: string,
  locale: string | undefined,
  field: "message" | "title",
): string | undefined {
  const bundle = bundleFor(locale);
  // A bundle is keyed by the camelCase kind; accept the activationResult spelling too.
  const key = kind.replace(/-(\w)/g, (_m, c: string) => c.toUpperCase());
  const pick = (b: CopyBundle) =>
    own(field === "message" ? b.messages : b.titles, key);
  return (
    pick(bundle) ??
    pick(EN) ??
    ownEntry(COPY_ACTIVATION, activationResult(kind))?.[field]
  );
}

/** The sentence for a typed activation result (`ActivationOutcome.kind`, or its
 *  activationResult spelling). `refused` names the server's `code`. */
export function activationMessage(
  kind: string,
  opts: { locale?: string; code?: string; params?: CopyParams } = {},
): string {
  const text = activationText(kind, opts.locale, "message");
  if (text === undefined) return copyMessage(kind, opts);
  return fill(text, opts.code ?? kind, opts.params ?? {});
}

/** The heading for a typed activation result. */
export function activationTitle(kind: string, locale?: string): string {
  return activationText(kind, locale, "title") ?? copyTitle(kind, locale);
}

/** The sentence for an error a verb threw: the activation table for a classified activation
 *  result, else the server's code (`wireCode`) in the error-code table, else the SDK's own code. */
export function describeError(
  err: {
    code?: string;
    wireCode?: string;
    activation?: {
      kind: string;
      code: string;
      limit?: number;
      deviceCount?: number;
      retryAfterSeconds?: number;
    };
  } | null,
  locale?: string,
): string {
  if (!err) return copyMessage("unknown", { locale });
  const a = err.activation;
  if (a && a.kind !== "ok") {
    const params: CopyParams = {
      ...(a.limit !== undefined ? { limit: a.limit } : {}),
      ...(a.deviceCount !== undefined ? { deviceCount: a.deviceCount } : {}),
      ...(a.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: a.retryAfterSeconds }
        : {}),
    };
    // `refused` names the server's code: its own sentence when the catalog has one, else the
    // activation table's "refused ({code})". Every other kind reads the activation table.
    if (a.kind !== "refused")
      return activationMessage(a.kind, { locale, code: a.code, params });
    return hasCopy(a.code)
      ? copyMessage(a.code, { locale, params })
      : activationMessage("refused", { locale, code: a.code, params });
  }
  if (err.wireCode && hasCopy(err.wireCode))
    return copyMessage(err.wireCode, { locale });
  return copyMessage(err.code ?? "unknown", { locale });
}
