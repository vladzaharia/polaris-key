// Fixture tree for rule 2; not part of any package.
export function read(client: any): unknown {
  const a = client.config.getConfig("theme");
  const b = client.config.getConfig("size"); // api-allow: kept for the migration test
  // api-allow: the next line is the documented old call
  const c = client.config.getConfig("old");
  const d = client.config.get("theme");
  const e = client.config.getConfigSource("theme");
  const f = client.config.getConfigSource("x"); // api-allow:
  return [a, b, c, d, e, f];
}
