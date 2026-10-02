// The two Vite features `corpusV2.browser.test.ts` uses, typed here because this package lists
// no `vite/client` types: a `?url` import, and `import.meta.glob` with `{query: "?url", import:
// "default", eager: true}`, which maps each matched path to its URL.

declare module "*?url" {
  const url: string;
  export default url;
}

interface ImportMeta {
  glob<T>(
    pattern: string,
    options: { query: string; import: string; eager: true },
  ): Record<string, T>;
}
