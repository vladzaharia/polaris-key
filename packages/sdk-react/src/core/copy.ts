// The error copy catalog (SDK-PARITY-PASS §3.2): what a kit SAYS for a code, in one place.
//
//   copyMessage(code, { locale?, detail? })   the sentence a screen shows
//   copyTitle(code, locale?)                  the short heading above it
//   describeError(err, locale?)               the sentence for a PolarisError: its `wireCode`
//                                             (the server's code) first, then its own `code`
//
// Keys are every wire code in `conformance/parity/errors.json`, the user-facing client codes,
// every gate status and every §3.1 activation kind. A code with no entry falls back to a generic
// sentence that NAMES the code, never the raw server body: a body is not copy, and it is not
// localised.
//
// English is the base and French the proof locale; more locales are content, not code
// (`registerCopyLocale`). The shared base `conformance/parity/copy.en.json` and its generated
// per-language emitters are planned in SP-00/SP-03 (a conformance change, plan mode); until it
// exists this table is the React base, and `test/copy.test.ts` pins that every registered wire
// code has an English and a French entry, so the generated file can replace it key for key.

/** A locale bundle: code → sentence, and code → title. */
export interface CopyBundle {
  messages: Record<string, string>;
  titles?: Record<string, string>;
  /** The fallback sentence; `{code}` is replaced by the code. */
  generic: string;
}

const EN: CopyBundle = {
  generic: "Something went wrong ({code}). Please try again.",
  titles: {
    deviceLimit: "Device limit reached",
    device_limit: "Device limit reached",
    licenseDisabled: "License disabled",
    license_disabled: "License disabled",
    licenseExpired: "License expired",
    license_expired: "License expired",
    enrollClaimed: "Sign in to continue",
    enroll_claimed: "Sign in to continue",
    rateLimited: "Too many attempts",
    rate_limited: "Too many attempts",
    unauthorized: "Key not accepted",
    network: "You're offline",
    "network-error": "You're offline",
    attestation_required: "Device check required",
    attestationRequired: "Device check required",
    "needs-activation": "Activation required",
    revoked: "License revoked",
    expired: "License expired",
    grace: "Offline grace",
    "version-too-old": "Update required",
    "version-too-new": "Version not allowed",
    "channel-not-entitled": "Channel not entitled",
  },
  messages: {
    // ── §3.1 activation kinds ────────────────────────────────────────────────
    deviceLimit:
      "This license has reached its device limit. Free a device in your account, then try again.",
    fingerprintRequired:
      "This license needs a device check this app can't provide here. Contact the developer.",
    hardwareMismatch:
      "This device changed since it was activated. Activate again to bind it.",
    enrollClaimed:
      "This device's free license now belongs to an account. Sign in to use it.",
    licenseDisabled:
      "This license was disabled. Contact the seller or your administrator.",
    licenseExpired: "This license has expired. Renew it to keep using the app.",
    attestationRequired:
      "This product only runs on verified devices, and this device couldn't be verified.",
    rateLimited: "Too many attempts. Wait a moment, then try again.",
    enrollDisabled:
      "Free activation isn't offered for this product. Enter a key or sign in.",
    refused: "The licensing service refused this request ({code}).",
    error:
      "We couldn't reach the licensing service. Check your connection and try again.",
    // ── wire codes (conformance/parity/errors.json) ──────────────────────────
    unauthorized:
      "That key was not accepted. Check it for typos and try again.",
    not_found: "That item doesn't exist, or this product doesn't offer it.",
    bad_request: "The request was not valid. Update the app and try again.",
    forbidden: "You're not allowed to do that with this license.",
    attestation_required:
      "This product only runs on verified devices, and this device couldn't be verified.",
    attestation_rejected: "This device couldn't be verified. Try again later.",
    attestation_unavailable:
      "Device verification isn't set up for this product yet.",
    rate_limited: "Too many attempts. Wait a moment, then try again.",
    body_too_large: "That was too large to send.",
    method_not_allowed:
      "This app sent a request the service doesn't accept. Update the app.",
    misconfigured:
      "This product isn't fully set up yet. Contact the developer.",
    registration_closed:
      "This product needs a license key or a sign-in before this device can join.",
    value_not_representable:
      "That value can't be saved. Remove unusual characters and try again.",
    document_not_representable:
      "The developer's configuration can't be delivered right now. Try again later.",
    device_limit:
      "This license has reached its device limit. Free a device in your account, then try again.",
    license_disabled:
      "This license was disabled. Contact the seller or your administrator.",
    license_expired:
      "This license has expired. Renew it to keep using the app.",
    not_entitled: "Your license doesn't include this.",
    version_blocked:
      "This version of the app isn't allowed by your license. Update the app.",
    channel_not_allowed: "Your license doesn't include this release channel.",
    hardware_mismatch:
      "This device changed since it was activated. Activate again to bind it.",
    fingerprint_required:
      "This license needs a device check this app can't provide here. Contact the developer.",
    enroll_disabled:
      "Free activation isn't offered for this product. Enter a key or sign in.",
    enroll_claimed:
      "This device's free license now belongs to an account. Sign in to use it.",
    enroll_failed: "Free activation couldn't finish. Try again in a moment.",
    managed_by_admin: "Your administrator manages this setting.",
    catalog_unavailable:
      "Settings can't be delivered right now. Try again later.",
    disabled: "Sign-in isn't set up for this product.",
    oidc_error: "The sign-in provider didn't answer correctly. Try again.",
    unavailable: "Sign-in is busy right now. Try again in a moment.",
    auth_method_disabled: "That sign-in method is turned off.",
    email_not_configured: "Email sign-in isn't available right now.",
    license_owned:
      "This license belongs to another account. Sign in with that account.",
    email_mismatch: "This license was sold to a different email address.",
    link_conflict: "That sign-in method is already linked to another account.",
    last_link: "You can't remove your only sign-in method.",
    step_up_required: "Sign in again to confirm it's you.",
    not_eligible: "This offer is no longer available.",
    download_auth_required: "Sign in or activate to download this.",
    delivery_gate_missing:
      "This download isn't available yet. Contact the developer.",
    upstream_rate_limited:
      "Downloads are busy right now. Try again in a moment.",
    server_misconfigured:
      "This product isn't fully set up yet. Contact the developer.",
    internal_error: "The download service failed. Try again in a moment.",
    release_record_rejected: "This release couldn't be published.",
    release_tag_is_pack_release: "This release couldn't be published.",
    feed_not_composable: "Updates can't be checked right now. Try again later.",
    // ── client codes a screen shows ──────────────────────────────────────────
    network:
      "We couldn't reach the licensing service. Check your connection and try again.",
    "network-error":
      "We couldn't reach the licensing service. Check your connection and try again.",
    "server-error":
      "The licensing service had a problem. Try again in a moment.",
    timeout: "The licensing service took too long to answer. Try again.",
    "service-disabled": "That isn't enabled for this product.",
    "service-unavailable": "That isn't available for this product.",
    "key-entry-unsupported":
      "Key entry isn't available here. Use the sign-in button instead.",
    "device-management-unsupported":
      "This app can't manage devices from here. Open your account to review them.",
    "refresh-failed":
      "We couldn't refresh your license. Try again in a moment.",
    "bridge-missing":
      "The licensing service isn't available in this app. Reinstall it or contact support.",
    "sign-in-failed": "Sign-in failed. Please try again.",
    "sign-in-expired": "The sign-in code expired. Start again.",
    "sign-in-denied": "The sign-in was declined.",
    "sign-in-unavailable":
      "Sign-in can't start right now. Try again in a moment.",
    "sign-out-failed": "We couldn't sign you out. Try again.",
    "bundle-rejected": "That activation file isn't valid for this device.",
    "bundle-import-unsupported": "This app can't import activation files here.",
    "bundle-jws-rejected": "That activation file's signature isn't valid.",
    "bundle-claims-rejected":
      "That activation file is for another device, or it has expired.",
    "bundle-trust-rejected": "That activation file wasn't issued for this app.",
    "inner-doc-rejected": "Part of that activation file failed verification.",
    "release-refused": "Your license doesn't include this download.",
    "report-unsupported": "This app can't send device reports here.",
    unsupported: "That isn't supported here.",
    "no-token": "Activate or sign in first.",
    "mint-unavailable": "That service token can't be issued right now.",
    "not-configured": "This app isn't configured for that yet.",
    "store-failed":
      "This browser couldn't save your sign-in. Check its storage settings.",
    cancelled: "Cancelled.",
    // ── gate statuses ────────────────────────────────────────────────────────
    ok: "Your license is active.",
    grace:
      "The licensing service is offline. You can keep working until grace ends.",
    expired:
      "Your license or offline grace period has ended. Sign in or activate a key to continue.",
    revoked:
      "This license is no longer active on this device. Contact your administrator.",
    "needs-activation": "Sign in or enter a license key to unlock this app.",
    "version-too-old":
      "This version is no longer supported. Please update the app.",
    "version-too-new": "This app version is newer than your license permits.",
    "channel-not-entitled":
      "Your license doesn't include this release channel. Switch channels or contact your administrator.",
    "not-applicable": "This product is not licensed separately.",
  },
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
    auth_method_disabled: "Cette méthode de connexion est désactivée.",
    email_not_configured:
      "La connexion par e-mail n'est pas disponible pour le moment.",
    license_owned:
      "Cette licence appartient à un autre compte. Connectez-vous avec ce compte.",
    email_mismatch: "Cette licence a été vendue à une autre adresse e-mail.",
    link_conflict:
      "Cette méthode de connexion est déjà liée à un autre compte.",
    last_link: "Vous ne pouvez pas retirer votre seule méthode de connexion.",
    step_up_required: "Reconnectez-vous pour confirmer votre identité.",
    not_eligible: "Cette offre n'est plus disponible.",
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

/** Add or replace a locale's bundle. Entries missing from it fall back to English. */
export function registerCopyLocale(locale: string, bundle: CopyBundle): void {
  LOCALES.set(locale.toLowerCase(), bundle);
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

/** Whether a locale's bundle (not the English fallback) has its own sentence for `code`. */
export function hasCopy(code: string, locale = "en"): boolean {
  return own(bundleFor(locale).messages, code) !== undefined;
}

/**
 * The sentence for `code`. `{code}` in a sentence is replaced by the code; `detail` (a refusal's
 * `reason`, for instance) is appended in parentheses when given. An unknown code falls back to
 * the locale's generic sentence naming it — never the server's raw body.
 */
export function copyMessage(
  code: string,
  opts: { locale?: string; detail?: string; codeLabel?: string } = {},
): string {
  const bundle = bundleFor(opts.locale);
  const text =
    own(bundle.messages, code) ??
    own(EN.messages, code) ??
    (bundle.generic || EN.generic);
  const out = text.replace(/\{code\}/g, opts.codeLabel ?? code);
  return opts.detail ? `${out} (${opts.detail})` : out;
}

/** The short heading for `code`, or the locale's generic error title. */
export function copyTitle(code: string, locale?: string): string {
  const bundle = bundleFor(locale);
  return (
    own(bundle.titles, code) ??
    own(EN.titles, code) ??
    (bundleFor(locale) === FR
      ? "Une erreur s'est produite"
      : "Something went wrong")
  );
}

/** The sentence for an error a verb threw: the activation kind for a classified refusal, else
 *  the server's code (`wireCode`), else the SDK's own code. */
export function describeError(
  err: {
    code?: string;
    wireCode?: string;
    activation?: { kind: string; code: string };
  } | null,
  locale?: string,
): string {
  if (!err) return copyMessage("unknown", { locale });
  const a = err.activation;
  if (a && a.kind !== "ok") {
    // `refused` names the server's code; every other kind has its own sentence.
    if (a.kind !== "refused") return copyMessage(a.kind, { locale });
    return hasCopy(a.code)
      ? copyMessage(a.code, { locale })
      : copyMessage("refused", { locale, codeLabel: a.code });
  }
  if (err.wireCode && hasCopy(err.wireCode))
    return copyMessage(err.wireCode, { locale });
  return copyMessage(err.code ?? "unknown", { locale });
}
