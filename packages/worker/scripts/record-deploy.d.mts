/** Types for `record-deploy.mjs` (imported by `test/recordDeploy.test.ts`). */
export interface DeployRowFields {
  id: string;
  at: number;
  environment: string;
  tag: string;
  gitSha: string;
  runUrl: string | null;
  scripts: string[];
  latestMigration: string | null;
  cfVersionId: string | null;
  deltasVersionId: string | null;
  smoke: string | null;
}
export declare function latestMigration(dir?: string): string | null;
export declare function versionIdFrom(
  ndjson: string | null | undefined,
): string | null;
export declare function deployRowSql(fields: DeployRowFields): string;
export declare function rowFromEnv(
  env: Record<string, string | undefined>,
  now?: number,
): DeployRowFields;
