/**
 * An `IN` list that does not count against D1's 100 bound-parameter limit.
 *
 * `IN (?, ?, ...)` binds one parameter per element, so a user with more than ~100 subjects,
 * licences or devices made the statement fail (a 500 on user detail and merge; potentially an
 * erasure that cannot finish). `IN ${jsonList()}` takes the whole list as ONE parameter,
 * `jsonListArg(values)`.
 */
export function jsonList(): string {
  return "(SELECT value FROM json_each(?))";
}

export function jsonListArg(values: readonly string[]): string {
  return JSON.stringify(values);
}
