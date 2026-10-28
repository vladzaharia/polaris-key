// The automatic sign-in scenes' axe pass (WCAG 2.2 AA).

import axe from "axe-core";

const RULES = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];

/** What axe finds inside `kit`, one line each (the page-level rules are the host's). */
export async function axeFindings(kit: HTMLElement): Promise<string[]> {
  const { violations } = await axe.run(kit, {
    runOnly: RULES,
    rules: {
      region: { enabled: false },
      "landmark-one-main": { enabled: false },
    },
  });
  return violations.flatMap((v) =>
    v.nodes.map(
      (n) => `${v.id}: ${n.target.join(" ")} ${n.any[0]?.message ?? ""}`,
    ),
  );
}
