/**
 * The search slice of the console API (P0-32.22): the palette's entity search.
 * Types and the `searchApi` methods live together; `api.ts` re-exports the types and spreads the methods.
 */
import { call } from "./transport.js";

/** `GET /manage/api/search` (ST-52; worker `console/handlers/search.ts`). */
export interface SearchLicenseDto {
  product: string;
  productName: string;
  id: string;
  name: string | null;
  email: string | null;
  status: string;
  expiresAt: number | null;
  tier: string | null;
}

export interface SearchDto {
  key: (SearchLicenseDto & { licenseId: string }) | null;
  licenses: SearchLicenseDto[];
  people: {
    product: string;
    productName: string;
    subject: string;
    name: string | null;
    email: string | null;
  }[];
}

export const searchApi = {
  /**
   * ST-52: the palette's entity search. The query goes in the body, never the URL: a pasted key
   * must not reach request logs. A pasted licence key resolves to `key` (its licence) and is never
   * echoed; a key the member may not read answers `key: null`, like an unknown one.
   */
  search: (q: string) =>
    call<SearchDto>("/manage/api/search", {
      method: "POST",
      body: JSON.stringify({ q }),
    }),
};
