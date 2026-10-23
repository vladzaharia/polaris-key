/**
 * The global pages' reads: one `queryOptions` factory per key family (components.md §7).
 * The platform settings view is a shared read in `data/reads.ts`.
 */

import { queryOptions } from "@tanstack/react-query";
import { api } from "../../../api.js";
import { mutate } from "../../data/mutations.js";
import { qk } from "../../data/queries.js";

export function fetchApiTokens() {
  return api.apiTokens().then((r) => r.tokens);
}

export const globalReads = {
  apiTokens: () =>
    queryOptions({ queryKey: qk.apiTokens(), queryFn: fetchApiTokens }),
  myPersonalTokens: () =>
    queryOptions({
      queryKey: qk.myPersonalTokens(),
      queryFn: () => api.myPersonalTokens().then((r) => r.tokens),
    }),
  personalTokens: () =>
    queryOptions({
      queryKey: qk.personalTokens(),
      queryFn: () => api.personalTokens().then((r) => r.tokens),
    }),
  slugCheck: (slug: string) =>
    queryOptions({
      queryKey: qk.slugCheck(slug),
      queryFn: () => api.slugCheck(slug),
    }),
  githubRepositories: (search: string) =>
    queryOptions({
      queryKey: qk.githubRepositories(search),
      queryFn: () => api.githubRepositories(search),
    }),
  /** W23: what `.pkey/` says about a repository (a read sent as POST; it declares no invalidation). */
  createCheck: (repo: string, input: string) =>
    queryOptions({
      queryKey: qk.createCheck(repo),
      queryFn: () => mutate("checkRepoCreate", input),
    }),
};
