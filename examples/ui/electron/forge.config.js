// Electron Forge with the Vite plugin: main, preload and renderer are three Vite builds.
export default {
  packagerConfig: {
    asar: true,
    // Sign in from a nearby device (macOS). The system asks for Local Network access the first
    // time the app looks for, or waits as, a nearby device; these two keys are what it reads.
    extendInfo: {
      NSLocalNetworkUsageDescription:
        "Tidewater Studio looks for your other signed-in devices on this network, so you can sign in without typing.",
      NSBonjourServices: ["_pkeypeer._tcp"],
    },
  },
  plugins: [
    {
      name: "@electron-forge/plugin-vite",
      config: {
        build: [
          {
            entry: "src/main.ts",
            config: "vite.main.config.mjs",
            target: "main",
          },
          {
            entry: "src/preload.ts",
            config: "vite.preload.config.mjs",
            target: "preload",
          },
        ],
        renderer: [{ name: "main_window", config: "vite.renderer.config.mjs" }],
      },
    },
  ],
};
