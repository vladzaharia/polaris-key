/** The group → tier map of a product's own provider (`oidc_config.group_role_map_json`). */

export interface GroupGrant {
  group: string;
  role: string | null;
  tier: string | null;
}

/**
 * `oidc_config.group_role_map_json`: `{ "<group>": { "role": "…", "tier": "<tierId>" } }`
 * (docs: services/identity/oidc). A bare string value is read as a role. `null` when the JSON is
 * absent; an empty list when it parses to no groups; `"invalid"` when it does not parse.
 */
export function parseGroupMap(json: string | null): GroupGrant[] | "invalid" {
  if (json === null || json.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return "invalid";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return "invalid";
  return Object.entries(parsed as Record<string, unknown>).map(
    ([group, grant]) => {
      if (typeof grant === "string") return { group, role: grant, tier: null };
      const g = (grant ?? {}) as { role?: unknown; tier?: unknown };
      return {
        group,
        role: typeof g.role === "string" ? g.role : null,
        tier: typeof g.tier === "string" ? g.tier : null,
      };
    },
  );
}
