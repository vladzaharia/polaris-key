/** The Identity section's reads (components.md §7). */

import { queryOptions } from "@tanstack/react-query";
import { api } from "../../../api.js";
import { qk } from "../../data/queries.js";

/** The product's sign-in settings. */
export const signInSettingsQuery = (slug: string) =>
  queryOptions({
    queryKey: qk.signInSettings(slug),
    queryFn: () => api.signInSettings(slug).then((res) => res.settings),
  });

/** Sign in with <Product> (I-21.14): the page, and one client with its secrets. */
export const identityClientsQuery = (slug: string) =>
  queryOptions({
    queryKey: qk.identityClients(slug),
    queryFn: () => api.identityClients(slug),
  });

export const identityClientQuery = (slug: string, id: string) =>
  queryOptions({
    queryKey: qk.identityClient(slug, id),
    queryFn: () => api.identityClient(slug, id),
    // An unknown client is a 404 the page words; do not retry it.
    retry: (n, e) => (e as { status?: number }).status !== 404 && n < 2,
  });

/** Platform → Issuer keys. */
export const issuerKeysQuery = () =>
  queryOptions({
    queryKey: qk.issuerKeys(),
    queryFn: () => api.issuerKeys().then((r) => r.products),
  });
