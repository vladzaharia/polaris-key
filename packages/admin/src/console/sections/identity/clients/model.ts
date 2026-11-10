/**
 * Sign in with <Product> (I-21.14): the words and the form model for a registered client. The
 * Worker applies the manifest's rules to every member; this file only keeps an obviously wrong
 * entry from being sent, and says what the server's refusal means beside its field.
 */

import type {
  IdentityClient,
  IdentityClientBody,
  IdentityClientClaim,
  IdentityClientScope,
  IdentityClientType,
} from "../../../../api.js";
import { formatCount } from "../../../../lib/format.js";

export const CLIENT_KEY_RE = /^[a-z][a-z0-9-]{1,31}$/;
export const NAME_MAX = 64;
export const REDIRECT_MAX = 10;

export const TYPE_LABEL: Record<IdentityClientType, string> = {
  web: "Web app (server)",
  spa: "Single-page app",
  native: "Native app",
};

export const TYPE_HELP: Record<IdentityClientType, string> = {
  web: "Keeps a client secret on its server.",
  spa: "Runs in the browser. No secret: it proves the sign-in with PKCE.",
  native:
    "Runs on a device. No secret. Redirects to a loopback or private-use address.",
};

/** What each scope hands the client, in the person's terms (the card says the same). */
export const SCOPES: {
  id: IdentityClientScope;
  label: string;
  help: string;
}[] = [
  {
    id: "openid",
    label: "Sign-in",
    help: "Who signed in, as an id that is the same for every app of this product.",
  },
  {
    id: "profile",
    label: "Name and picture",
    help: "The screen name and picture the person chooses to share.",
  },
  {
    id: "email",
    label: "Email address",
    help: "The person's verified email address, when they share it.",
  },
  {
    id: "pkey:entitlements",
    label: "Features",
    help: "Which features of this product the person has.",
  },
  {
    id: "offline_access",
    label: "Stay signed in",
    help: "A refresh token, so the client keeps working while the person is away.",
  },
];

export const CLAIMS: {
  id: IdentityClientClaim;
  label: string;
  needs: IdentityClientScope;
}[] = [
  { id: "name", label: "Name", needs: "profile" },
  { id: "picture", label: "Picture", needs: "profile" },
  { id: "email", label: "Email address", needs: "email" },
];

export const scopeLabel = (s: string): string =>
  SCOPES.find((x) => x.id === s)?.label ?? s;

export interface ClientValues {
  name: string;
  key: string;
  type: IdentityClientType;
  developerName: string;
  redirectUris: string;
  postLogoutRedirectUris: string;
  scopes: IdentityClientScope[];
  claimsRequired: IdentityClientClaim[];
}

export const EMPTY_CLIENT: ClientValues = {
  name: "",
  key: "",
  type: "web",
  developerName: "",
  redirectUris: "",
  postLogoutRedirectUris: "",
  scopes: ["openid", "profile"],
  claimsRequired: [],
};

export const valuesOf = (c: IdentityClient): ClientValues => ({
  name: c.name,
  key: c.key,
  type: c.type,
  developerName: c.developerName ?? "",
  redirectUris: c.redirectUris.join("\n"),
  postLogoutRedirectUris: c.postLogoutRedirectUris.join("\n"),
  scopes: c.scopes,
  claimsRequired: c.claimsRequired,
});

/** One address per line; blank lines and edge spaces are dropped. */
export const lines = (text: string): string[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");

/** A suggested key from a name: lower-case words joined by hyphens. */
export const keyFromName = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, 32);

/** The claims the chosen scopes can deliver. */
export const claimsDelivered = (
  scopes: readonly IdentityClientScope[],
): IdentityClientClaim[] =>
  CLAIMS.filter((c) => scopes.includes(c.needs)).map((c) => c.id);

export function validateClient(
  v: ClientValues,
  opts: { creating: boolean },
): Record<string, string> {
  const e: Record<string, string> = {};
  if (v.name.trim() === "")
    e.name = "Name the client. People see it when they sign in.";
  else if (v.name.trim().length > NAME_MAX)
    e.name = `Use ${NAME_MAX} characters or fewer.`;
  if (opts.creating && !CLIENT_KEY_RE.test(v.key))
    e.key =
      "2 to 32 characters: a lower-case letter, then letters, digits or hyphens.";
  if (v.developerName.trim().length > NAME_MAX)
    e.developerName = `Use ${NAME_MAX} characters or fewer.`;
  const redirects = lines(v.redirectUris);
  if (redirects.length === 0)
    e.redirectUris = "Add at least one redirect address.";
  else if (redirects.length > REDIRECT_MAX)
    e.redirectUris = `Use ${REDIRECT_MAX} addresses or fewer.`;
  if (lines(v.postLogoutRedirectUris).length > REDIRECT_MAX)
    e.postLogoutRedirectUris = `Use ${REDIRECT_MAX} addresses or fewer.`;
  if (!v.scopes.includes("openid")) e.scopes = "Sign-in is always on.";
  return e;
}

/** The body for a create, or for a patch (`only`: just the members that changed). */
export function bodyOf(
  v: ClientValues,
  creating: boolean,
  only?: ClientValues,
): IdentityClientBody {
  const claims = v.claimsRequired.filter((c) =>
    claimsDelivered(v.scopes).includes(c),
  );
  const full: IdentityClientBody = {
    ...(creating ? { key: v.key } : {}),
    name: v.name.trim(),
    developerName:
      v.developerName.trim() === "" ? null : v.developerName.trim(),
    type: v.type,
    redirectUris: lines(v.redirectUris),
    postLogoutRedirectUris: lines(v.postLogoutRedirectUris),
    scopes: v.scopes,
    claimsRequired: claims,
  };
  if (!only) return full;
  const was = bodyOf(only, false);
  return Object.fromEntries(
    Object.entries(full).filter(
      ([k, x]) =>
        JSON.stringify(x) !==
        JSON.stringify((was as Record<string, unknown>)[k]),
    ),
  ) as IdentityClientBody;
}

/** The host of an address; a private-use scheme without its colon; the address itself otherwise. */
export function hostOf(uri: string): string {
  try {
    const u = new URL(uri);
    return u.protocol === "https:" || u.protocol === "http:"
      ? u.host
      : u.protocol.replace(/:$/, "");
  } catch {
    return uri;
  }
}

/** The first host, and how many more there are: "forum.example.com +9". */
export function hostsOf(uris: readonly string[]): string {
  const hosts = [...new Set(uris.map(hostOf))];
  if (hosts.length === 0) return "";
  return hosts.length === 1
    ? hosts[0]!
    : `${hosts[0]} +${formatCount(hosts.length - 1)}`;
}

/** The form's fields in the order a person reads them: the first refusal is the one to fix first. */
export const FIELD_ORDER = [
  "name",
  "key",
  "type",
  "redirectUris",
  "postLogoutRedirectUris",
  "scopes",
  "claimsRequired",
  "developerName",
] as const;

const ADDRESS_FIELD = /^(redirectUris|postLogoutRedirectUris)\[(\d+)\] (.*)\.$/;

/**
 * What the Worker's refusal of one field means in the console's words. `reason` is the rule's code
 * and `message` the manifest's sentence for it (which names the list index); a code this does not
 * know keeps the Worker's own sentence.
 */
export function refusalCopy(
  field: string,
  reason: string | undefined,
  message: string | undefined,
): string {
  switch (reason) {
    case "key_exists":
      return "A client with this key already exists. Choose another.";
    case "invalid_client_key":
      return "2 to 32 characters: a lower-case letter, then letters, digits or hyphens.";
    case "invalid_client_type":
      return "Choose a type.";
    case "client_scope_unknown":
      return "Sign-in is always on, and each item is listed once.";
    case "client_claim_not_requested":
      return "An item can be always shared only when the client gets what delivers it: Name and picture, or Email address.";
    case "invalid_client_redirect": {
      const m = ADDRESS_FIELD.exec(message ?? "");
      const line = m ? `Line ${Number(m[2]) + 1}` : null;
      const what = m?.[3] ?? "";
      if (line) {
        if (what.startsWith("must be an https URI"))
          return `${line} isn't https. Loopback and app-scheme addresses are for native apps.`;
        if (what.startsWith("must be https, a loopback"))
          return `${line} isn't a valid address. Use https, a loopback address with a path and no port, or your reverse-DNS app scheme.`;
        if (what.startsWith("must not contain"))
          return `${line} has a space, a # fragment or a *. Remove it.`;
        if (what.startsWith("must have a host"))
          return `${line} needs a host and no sign-in details.`;
        if (what.startsWith("is not a valid https"))
          return `${line} isn't a valid https address.`;
        if (what.startsWith("must be at most")) return `${line} is too long.`;
        return `${line} isn't a valid address.`;
      }
      if ((message ?? "").includes("must not repeat"))
        return "Each address can appear only once.";
      return field === "redirectUris"
        ? `Add 1 to ${REDIRECT_MAX} addresses.`
        : `Use up to ${REDIRECT_MAX} addresses.`;
    }
    default:
      return message ?? "Check this value.";
  }
}
