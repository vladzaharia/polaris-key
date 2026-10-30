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
// ENGLISH IS GENERATED. `../copy.generated.ts` is written by `pnpm gen constants` from
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
// French is a hand table (the bundle size budget keeps the full generated packs out of the
// entry) whose every sentence is conformance/parity/copy.fr.json's, pinned by test/copy.test.ts;
// more locales are content, not code (`registerCopyLocale`). A non-English bundle is keyed by
// error code, gate status and §3.1 activation kind (camelCase, as `ActivationOutcome.kind`), and
// every key it lacks falls back to the generated English.

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
  /** Activation results (keyed by the camelCase kind) whose entry differs from the error code
   *  or gate status of the same name; read before `messages` and `titles` for an activation. */
  activation?: {
    messages?: Record<string, string>;
    titles?: Record<string, string>;
  };
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
  generic: "Une erreur s’est produite ({code}). Réessayez.",
  titles: {
    deviceLimit: "Limite d’appareils atteinte",
    device_limit: "Limite d’appareils atteinte",
    key_entry_limit: "Aucune saisie restante",
    device_keys_invalid: "Appareil non configuré",
    device_keys_required: "Appareil non lié",
    ring_too_large: "Trop d'appareils",
    relay_disabled: "Connexion à distance désactivée",
    relay_paused: "Connexion à distance en pause",
    relay_quota_exceeded: "Limite à distance atteinte",
    relay_ticket_invalid: "Connexion expirée",
    licenseDisabled: "Licence désactivée",
    license_disabled: "Licence désactivée",
    licenseExpired: "Licence expirée",
    license_expired: "Licence expirée",
    enrollClaimed: "Connectez-vous pour continuer",
    enroll_claimed: "Connectez-vous pour continuer",
    rateLimited: "Trop de tentatives",
    rate_limited: "Trop de tentatives",
    cursor_expired: "Synchronisation obsolète",
    client_mismatch: "Synchronisation incompatible",
    value_invalid: "Réglage non enregistré",
    op_invalid_for_policy: "Modification non autorisée",
    setting_not_synced: "Non synchronisé",
    collection_unknown: "Collection inconnue",
    quota_exceeded: "Stockage plein",
    writes_paused: "Synchronisation en pause",
    unauthorized: "Non connecté",
    network: "Connexion impossible",
    "network-error": "Connexion impossible",
    attestation_required: "Vérification de l’appareil requise",
    attestationRequired: "Vérification de l’appareil requise",
    "needs-activation": "Activer",
    revoked: "Déconnecté",
    expired: "Licence expirée",
    grace: "Période de grâce hors ligne",
    "version-too-old": "Mise à jour requise",
    "version-too-new": "Indisponible avec cette licence",
    "channel-not-entitled": "Canal non inclus",
  },
  messages: {
    deviceLimit:
      "Cette licence est déjà utilisée sur tous ses appareils. Remplacez un appareil pour l’utiliser ici.",
    fingerprintRequired:
      "Cette licence nécessite une empreinte matérielle, qui n’a pas pu être lue sur cet appareil.",
    hardwareMismatch:
      "Le matériel de cet appareil a changé. Réactivez-le pour utiliser votre licence ici.",
    enrollClaimed:
      "La licence gratuite de cet appareil appartient désormais à un compte. Connectez-vous pour l’utiliser.",
    licenseDisabled:
      "Cette licence a été désactivée. Contactez le développeur.",
    licenseExpired: "Cette licence a expiré. Renouvelez-la pour continuer.",
    attestationRequired:
      "Cette licence nécessite un appareil vérifié. Laissez l’app vérifier cet appareil, puis réessayez.",
    rateLimited: "Trop de tentatives. Patientez un instant, puis réessayez.",
    enrollDisabled:
      "Cette app ne propose pas de licence gratuite. Saisissez une clé de licence ou connectez-vous.",
    refused: "L’activation a été refusée ({code}).",
    error:
      "L’activation n’a pas abouti. Vérifiez votre connexion, puis réessayez.",
    unauthorized:
      "Cet appareil n’est pas connecté, ou sa licence n’est plus valide. Connectez-vous ou réactivez-le.",
    not_found: "Cet élément est introuvable. Il a peut-être été supprimé.",
    bad_request:
      "La requête n’était pas valide. Mettez l’app à jour, puis réessayez.",
    forbidden: "Vous n’avez pas l’autorisation d’effectuer cette action.",
    attestation_required:
      "Un appareil vérifié est nécessaire. Laissez l’app vérifier cet appareil, puis réessayez.",
    attestation_rejected: "Cet appareil n’a pas pu être vérifié. Réessayez.",
    attestation_unavailable:
      "La vérification des appareils n’est pas disponible pour cette app pour le moment. Réessayez dans quelques minutes.",
    rate_limited: "Trop de tentatives. Patientez un instant, puis réessayez.",
    cursor_expired:
      "Cet appareil ne s'est pas synchronisé depuis trop longtemps. Il repartira de vos données enregistrées.",
    client_mismatch:
      "Cette synchronisation appartient à un autre appareil. Redémarrez l'app et réessayez.",
    value_invalid: "Cette valeur n'est pas valide pour ce réglage.",
    op_invalid_for_policy:
      "Cette modification n'est pas autorisée pour ce réglage.",
    setting_not_synced: "Ce réglage n'est pas synchronisé avec votre compte.",
    collection_unknown: "Cette collection n'est pas disponible.",
    quota_exceeded:
      "Votre stockage synchronisé est plein. Libérez de l'espace, puis réessayez.",
    writes_paused:
      "La synchronisation est en pause un instant. Vos modifications sont conservées et seront synchronisées plus tard.",
    encryption_mismatch:
      "L’app et le service de synchronisation ne s’accordent pas sur le chiffrement. Mettez l’app à jour et réessayez.",
    revision_conflict:
      "Cet élément a été modifié sur un autre appareil. Actualisez, puis réessayez.",
    upload_mismatch: "Le fichier n’est pas arrivé intact. Réessayez.",
    upload_expired: "L’envoi a pris trop de temps et a été annulé. Réessayez.",
    upload_incomplete: "Une partie du fichier n’est pas arrivée. Réessayez.",
    file_too_large:
      "Ce fichier dépasse la taille maximale des fichiers synchronisés.",
    keyring_conflict:
      "Le chiffrement est déjà configuré pour ce compte. Déverrouillez avec un autre appareil ou votre code de récupération.",
    body_too_large: "Cet élément est trop volumineux pour être envoyé.",
    method_not_allowed:
      "La requête n’était pas valide. Mettez l’app à jour, puis réessayez.",
    misconfigured:
      "Ce service n’est pas correctement configuré. Contactez le développeur.",
    registration_closed:
      "Les nouveaux appareils ne peuvent pas s’enregistrer pour le moment. Activez cet appareil avec une clé de licence ou connectez-vous.",
    value_not_representable:
      "Une valeur n’a pas pu être enregistrée. Modifiez-la, puis réessayez.",
    document_not_representable:
      "Le service n’a pas pu préparer vos paramètres. Contactez le développeur.",
    signing_unavailable:
      "Le service ne peut pas signer de document pour le moment. Réessayez dans quelques minutes.",
    device_limit:
      "Cette licence est déjà utilisée sur tous ses appareils. Remplacez un appareil pour l’utiliser ici.",
    key_entry_limit:
      "Cette clé n’a plus de saisies disponibles. Ajoutez-la à votre compte et connectez-vous à la place.",
    device_keys_invalid:
      "Cet appareil n’a pas pu être configuré pour la synchronisation. Mettez l’app à jour et réessayez.",
    device_keys_required:
      "Cet appareil n'a pas été configuré pour se lier à vos autres appareils. Mettez à jour l'app et réessayez.",
    ring_too_large:
      "Ce compte compte plus d'appareils liés que l'on ne peut en connecter. Retirez-en un et réessayez.",
    relay_disabled:
      "La connexion à distance est désactivée pour cette app. Vos appareils se connectent uniquement sur le même réseau.",
    relay_paused:
      "La connexion à distance est en pause pour le moment. Réessayez plus tard.",
    relay_quota_exceeded:
      "La limite de connexion à distance est épuisée. Elle se réinitialise bientôt. Les appareils du même réseau se connectent toujours.",
    relay_ticket_invalid: "La demande de connexion a expiré. Réessayez.",
    license_disabled:
      "Cette licence a été désactivée. Contactez le développeur.",
    license_unusable:
      "Votre licence n’est plus valide, les paramètres ne peuvent donc pas être chargés. Connectez-vous ou réactivez-la.",
    license_expired: "Cette licence a expiré. Renouvelez-la pour continuer.",
    not_entitled: "Votre licence n’inclut pas cet élément.",
    version_blocked:
      "Cette version ne peut pas être utilisée avec votre licence. Mettez l’app à jour pour continuer.",
    channel_not_allowed: "Votre licence n’inclut pas ce canal.",
    hardware_mismatch:
      "Le matériel de cet appareil a changé. Réactivez-le pour utiliser votre licence ici.",
    fingerprint_required:
      "Cette licence nécessite une empreinte matérielle, qui n’a pas pu être lue sur cet appareil.",
    enroll_disabled:
      "Cette app ne propose pas de licence gratuite. Saisissez une clé de licence ou connectez-vous.",
    enroll_claimed:
      "La licence gratuite de cet appareil appartient désormais à un compte. Connectez-vous pour l’utiliser.",
    enroll_failed:
      "Une licence gratuite n’a pas pu être émise. Réessayez dans quelques minutes.",
    managed_by_admin:
      "Ce paramètre est géré par votre organisation et ne peut pas être modifié ici.",
    catalog_unavailable:
      "Les paramètres ne peuvent pas être chargés pour le moment. Réessayez dans quelques minutes.",
    disabled: "La connexion n’est pas activée pour cette app.",
    oidc_error: "La connexion n’a pas abouti. Réessayez.",
    unavailable:
      "La connexion n’est pas disponible pour le moment. Réessayez dans quelques minutes.",
    erasure_ledger_unavailable:
      "Nous n’avons pas pu confirmer l’état de votre compte pour le moment. Réessayez dans quelques minutes.",
    identity_disabled:
      "La connexion via cette app est désactivée. Vos installations et vos licences continuent de fonctionner.",
    unknown_app: "La connexion n’est pas disponible pour cette app.",
    // I-08 (WIRE-CONTRACT-V4 §12.4, §12.5): the OAuth-shaped passthrough.
    invalid_request:
      "L’app a envoyé une demande de connexion illisible. Réessayez.",
    invalid_client:
      "La connexion de cette app n’est pas correctement configurée. Elle s’est donc arrêtée ici pour protéger votre compte. Prévenez son développeur.",
    invalid_grant:
      "Cette connexion a expiré ou a déjà été utilisée. Connectez-vous à nouveau.",
    unsupported_grant_type:
      "L’app a demandé un type de connexion que nous ne prenons pas en charge. Contactez son développeur.",
    invalid_scope:
      "L’app a demandé un accès que cette connexion ne propose pas. Contactez son développeur.",
    redirect_uri_mismatch:
      "La connexion de cette app n’est pas correctement configurée. Elle s’est donc arrêtée ici pour protéger votre compte. Prévenez son développeur.",
    license_choice_required:
      "Choisissez la licence que cet appareil utilise, puis continuez.",
    interstitial_required:
      "Terminez la connexion sur la page Polaris Locker, puis revenez à l’app.",
    not_nearby:
      "L’autre appareil n’est pas sur ce réseau. Connectez les deux au même Wi-Fi, ou utilisez un code à la place.",
    auth_method_disabled:
      "Cette méthode de connexion est désactivée. Choisissez-en une autre.",
    email_unavailable:
      "La connexion par e-mail n’est pas disponible pour le moment. Choisissez une autre méthode de connexion.",
    turnstile_failed:
      "La vérification de sécurité a échoué. Rechargez la page, puis réessayez.",
    signin_expired: "Cette connexion a expiré. Recommencez.",
    invalid_code: "Ce code est incorrect. Vérifiez l’e-mail, puis réessayez.",
    code_expired: "Ce code a expiré. Demandez un nouveau code.",
    email_in_use:
      "Un autre compte Polaris Locker utilise déjà cette adresse e-mail. Associez cette connexion à ce compte, ou utilisez une autre adresse.",
    terms_required: "Acceptez les conditions pour continuer.",
    license_owned:
      "Connectez-vous au compte Polaris Locker qui contient cette licence {product} pour l’utiliser.",
    // I-09 (WIRE-CONTRACT-V4 §12.3): the device attach's two account refusals.
    license_email_bound:
      "Cette licence est liée à une adresse e-mail que votre compte Polaris Locker n’a pas vérifiée. Vérifiez cette adresse dans votre compte, puis réessayez.",
    account_required:
      "Connectez-vous à votre compte Polaris Locker sur cet appareil, puis réessayez.",
    email_mismatch:
      "Cette licence est liée à une adresse e-mail que votre compte n’a pas vérifiée. Ajoutez et vérifiez cette adresse, puis réessayez.",
    link_conflict:
      "Cette méthode de connexion appartient à un autre compte Polaris Locker. Connectez-vous à ce compte, ou fusionnez les deux comptes.",
    last_link:
      "C’est la seule méthode de connexion de votre compte. Ajoutez-en une autre avant de la supprimer.",
    step_up_required:
      "Pour votre sécurité, connectez-vous à nouveau pour continuer.",
    not_eligible:
      "Cette offre n’est plus disponible pour votre compte. Actualisez, puis réessayez.",
    not_removable:
      "Cette licence ne peut pas être ajoutée de nouveau avec une clé : elle reste donc dans votre bibliothèque.",
    download_auth_required:
      "Connectez-vous ou activez une licence pour télécharger cet élément.",
    delivery_gate_missing:
      "Ce téléchargement n’est pas encore configuré. Contactez le développeur.",
    upstream_rate_limited:
      "Les téléchargements sont très sollicités pour le moment. Réessayez dans quelques minutes.",
    server_misconfigured:
      "Ce service n’est pas correctement configuré. Contactez le développeur.",
    internal_error:
      "Le serveur de téléchargement a rencontré un problème. Réessayez dans quelques minutes.",
    release_record_rejected:
      "La version n’a pas été publiée, car une vérification a échoué. Le journal de publication indique laquelle.",
    release_tag_is_pack_release:
      "Une version a été ignorée, car son tag correspond à une version de pack de contenu. Renommez le tag.",
    asset_unreachable:
      "Une image n’a pas pu être récupérée depuis sa source. La copie précédente reste affichée, et une nouvelle tentative aura lieu automatiquement.",
    feed_not_composable:
      "Les mises à jour ne peuvent pas être vérifiées pour le moment. Réessayez dans quelques minutes.",
    network:
      "Impossible de joindre Polaris Locker. Vérifiez votre connexion, puis réessayez.",
    "network-error":
      "Impossible de joindre Polaris Locker. Vérifiez votre connexion, puis réessayez.",
    "server-error":
      "Le service a rencontré un problème. Réessayez dans quelques minutes.",
    timeout:
      "Le service a mis trop de temps à répondre. Vérifiez votre connexion, puis réessayez.",
    "service-disabled": "Ce service est désactivé pour cette app.",
    "service-unavailable": "Cette app n’utilise pas ce service.",
    "key-entry-unsupported":
      "Les clés de licence ne peuvent pas être saisies ici. Connectez-vous à la place.",
    "device-management-unsupported":
      "Les appareils ne peuvent pas être gérés ici. Gérez-les dans votre compte.",
    "refresh-failed":
      "Votre licence et vos paramètres n’ont pas pu être actualisés. Vérifiez votre connexion, puis réessayez.",
    "bridge-missing":
      "Le pont de licence de l’app est introuvable. Réinstallez l’app ou contactez le développeur.",
    "sign-in-failed": "La connexion n’a pas abouti. Réessayez.",
    "sign-in-expired":
      "Le code a expiré avant la fin de la connexion. Recommencez.",
    "sign-in-denied": "La connexion a été refusée. Recommencez.",
    "sign-in-unavailable":
      "La connexion n’est pas disponible pour le moment. Réessayez dans quelques minutes.",
    "platform-identity-unavailable":
      "Cet appareil ne peut pas vous connecter automatiquement. Utilisez une autre méthode de connexion.",
    "sync-locked":
      "Déverrouillez la synchronisation sur cet appareil avec votre code de récupération ou un autre appareil connecté.",
    "recovery-code-invalid":
      "Ce code de récupération n’est pas correct. Vérifiez-le et réessayez.",
    "sync-encryption-pinned":
      "Cette app exige une synchronisation chiffrée, indisponible pour le moment. La synchronisation reste désactivée.",
    "sign-out-failed": "La déconnexion n’a pas abouti. Réessayez.",
    "bundle-rejected": "Le fichier d’activation a été refusé.",
    "bundle-import-unsupported":
      "L’activation hors ligne n’est pas disponible ici.",
    "bundle-jws-rejected":
      "La signature du fichier d’activation n’est pas valide.",
    "bundle-claims-rejected":
      "Le fichier d’activation concerne un autre produit ou un autre appareil, ou il a expiré.",
    "bundle-trust-rejected":
      "Le fichier d’activation est signé par une clé que cette app ne reconnaît pas.",
    "inner-doc-rejected":
      "La licence contenue dans le fichier d’activation n’est pas valide.",
    "release-refused": "Votre licence n’inclut pas cette version.",
    "report-unsupported":
      "Les rapports d’appareil ne sont pas disponibles ici.",
    unsupported: "Cette fonction n’est pas disponible ici.",
    "no-token":
      "Cet appareil n’est pas encore activé. Activez-le ou connectez-vous.",
    "mint-unavailable": "Cette fonction n’est pas disponible pour cette app.",
    "not-configured":
      "La gestion des licences de l’app n’est pas encore configurée. Contactez le développeur.",
    "store-failed":
      "Enregistrement impossible sur cet appareil. Vérifiez le stockage et réessayez.",
    cancelled: "La connexion a été annulée.",
    ok: "Votre licence est active.",
    grace:
      "Le service de licence est inaccessible. Vous pouvez continuer à utiliser l’app jusqu’à la fin de la période de grâce.",
    expired:
      "Connectez-vous à Internet ou renouvelez votre licence pour continuer.",
    revoked:
      "Cet appareil a été déconnecté. Connectez-vous ou réactivez-le pour continuer.",
    "needs-activation":
      "Saisissez une clé de licence ou connectez-vous pour continuer.",
    "version-too-old":
      "Cette version n’est plus prise en charge. Mettez {product} à jour pour continuer.",
    "version-too-new":
      "Ce build est plus récent que ce que votre licence autorise.",
    "channel-not-entitled": "Votre licence n’inclut pas ce canal.",
    "not-applicable": "Cette app n’a pas besoin de licence.",
  },
  // An activation result whose name is also an error code or a gate status reads its own
  // entry here (the error code `unauthorized` is "Non connecté", the activation result
  // "Clé non acceptée").
  activation: {
    titles: {
      ok: "Activé",
      unauthorized: "Clé non acceptée",
      keyEntryLimit: "Aucune saisie restante",
    },
    messages: {
      ok: "Votre licence est active sur cet appareil.",
      unauthorized:
        "Cette clé de licence n’a pas été acceptée. Vérifiez-la, puis réessayez.",
      keyEntryLimit:
        "Connectez-vous et ajoutez plutôt cette clé à votre compte Polaris Locker.",
    },
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
    (bundle === FR ? "Une erreur s’est produite" : COPY_FALLBACK.title)
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
    own(
      field === "message" ? b.activation?.messages : b.activation?.titles,
      key,
    ) ?? own(field === "message" ? b.messages : b.titles, key);
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
    // activation table's "refused ({code})"; `licenseOwned` (no activation entry of its own,
    // I-46.1's copy) reads the same way. Every other kind reads the activation table.
    if (a.kind !== "refused" && a.kind !== "licenseOwned")
      return activationMessage(a.kind, { locale, code: a.code, params });
    return hasCopy(a.code)
      ? copyMessage(a.code, { locale, params })
      : activationMessage("refused", { locale, code: a.code, params });
  }
  if (err.wireCode && hasCopy(err.wireCode))
    return copyMessage(err.wireCode, { locale });
  return copyMessage(err.code ?? "unknown", { locale });
}
