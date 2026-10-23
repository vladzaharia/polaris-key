// Fixture for tools/api-check.test.ts (rule 1, TypeScript). Not part of any package.
export class FixtureClient {
  get(key: string): string {
    return key;
  }
  getConfig(key: string): string {
    return key;
  }
  helper(): void {}
  extra(): void {}
  private secret(): void {}
  protected inner(): void {}
  _internal(): void {}
  readonly status = "ok";
  constructor() {}
}

export function useThing(): void {}
export const useOther = (): void => {};
function notExported(): void {}
void notExported;
