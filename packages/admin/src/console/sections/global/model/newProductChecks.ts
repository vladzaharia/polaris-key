/**
 * The New product wizard's refusals as words (ST-43): why a repository check could not be read,
 * and the errors on the Name step's two fields. Pure.
 */

import {
  HttpError,
  type GithubRepositories,
  type SlugCheck,
} from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import type { CheckFailure } from "../components/NewProductRepo.js";
import type { SlugVerdict } from "./newProduct.js";

/**
 * Why the dry run failed, as what to do next. The server answers 404 the same way for an App that
 * is not installed and a repository that is not there: when the App is on the owner already, the
 * name is the likelier fault.
 */
export function checkFailure(
  error: unknown,
  repo: string | null,
  repos: GithubRepositories | undefined,
  installUrl: string | null,
): CheckFailure | null {
  if (!error || !repo) return null;
  const owner = repo.split("/")[0]!;
  const known = repos?.installations.some(
    (i) => i.account.toLowerCase() === owner.toLowerCase(),
  );
  const copy = errorCopy(error, { thing: "Product", repo });
  if (!(error instanceof HttpError) || error.status === 0)
    return {
      kind: "network",
      title: copy.title,
      description: copy.description,
      installUrl,
    };
  if (copy.fix?.kind === "install-github-app")
    return known
      ? {
          kind: "notfound",
          title: `${repo} wasn't found`,
          description:
            "Check the name. If it exists, add it to the app's repositories on GitHub, then check again.",
          installUrl,
        }
      : {
          kind: "app",
          title: `The GitHub App can't read ${repo}`,
          description: `Install it on ${owner}, then check again.`,
          installUrl,
        };
  return {
    kind: "other",
    title: copy.title,
    description: copy.description,
    installUrl,
  };
}

/** The errors the Name step shows: the server's word first, then the live checks. */
export function nameFieldErrors(i: {
  showErrors: boolean;
  name: string;
  slug: string;
  local: SlugVerdict;
  slugAnswer: SlugCheck | null;
  slugServer: { message: string } | null;
}): { name?: string; slug?: string } {
  const out: { name?: string; slug?: string } = {};
  if (i.showErrors && i.name.trim() === "")
    out.name = "Enter the product's name.";
  if (i.slugServer) out.slug = i.slugServer.message;
  else if (i.local.kind === "invalid") out.slug = i.local.message;
  else if (i.local.kind === "reserved")
    out.slug = `${i.slug} is reserved. Choose another slug.`;
  else if (i.slugAnswer && i.slugAnswer.status !== "available")
    out.slug = i.slugAnswer.suggestion
      ? `${i.slug} is ${i.slugAnswer.status}. Try ${i.slugAnswer.suggestion}.`
      : i.slugAnswer.message;
  else if (i.showErrors && i.local.kind === "empty") out.slug = "Enter a slug.";
  return out;
}
