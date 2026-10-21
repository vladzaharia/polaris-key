import { describe, expect, it } from "vitest";
import type { AttentionItemDto } from "../src/api.js";
import {
  pendingRecipesOf,
  reviewHref,
} from "../src/console/sections/config/model/pending.js";

const item = (
  slug: string,
  kind: AttentionItemDto["kind"],
  recipe?: string,
): AttentionItemDto => ({
  id: `${slug}:${kind}:${recipe ?? ""}`,
  product: { slug, name: slug },
  kind,
  tone: "warning",
  service: "config",
  short: "x",
  lines: [],
  action: {
    label: "Open",
    page: "keys",
    query: recipe ? { recipe } : undefined,
  },
  area: "config",
});

describe("pendingRecipesOf", () => {
  it("lists this product's mint.pending recipes and nothing else", () => {
    const items = [
      item("djdl", "mint.pending", "music"),
      item("djdl", "mint.pending", "video"),
      item("djdl", "secret.missing", "S"),
      item("acme", "mint.pending", "other"),
    ];
    expect(pendingRecipesOf(items, "djdl")).toEqual(["music", "video"]);
    expect(pendingRecipesOf(items, "acme")).toEqual(["other"]);
  });

  it("is empty before the read answers", () => {
    expect(pendingRecipesOf(undefined, "djdl")).toEqual([]);
  });

  it("reviewHref goes to the one recipe, or the catalog for several or none", () => {
    expect(reviewHref("djdl", ["music"])).toContain("music");
    expect(reviewHref("djdl", ["a", "b"])).toBe(reviewHref("djdl", []));
  });
});
