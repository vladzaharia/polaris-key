/** The smallest valid product and release documents the outlet tests build on. */
export const product = {
  slug: "dice",
  name: "Dice",
  modules: {
    license: { enabled: true },
    release: { enabled: true },
    distribution: { enabled: true },
  },
};
export const release = {
  release: {
    provider: { type: "github", owner: "acme", repo: "dice" },
    deliverables: {
      app: {
        kind: "app",
        artifacts: [
          {
            id: "apk",
            platform: "android",
            arch: "any",
            format: "apk",
            match: "Dice-*.apk",
          },
        ],
      },
    },
  },
};
