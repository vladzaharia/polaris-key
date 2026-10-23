// Fixture for tools/api-check.test.ts (rule 1 spelling namespaces and rule 3). Not part of any package.
export class LicenseFixture {
  isEntitled(name: string): boolean {
    return name.length > 0;
  }
  getQuantity(name: string): number {
    return name.length;
  }
}
