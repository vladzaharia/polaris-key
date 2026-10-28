// Electron main: the privileged side owns the client; the window gets the PolarisBridge.
//
//   npm start            the Tidewater fixture (TIDEWATER_STATE pins the gate)
//   npm run live         the real client from src/polaris.config.ts
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  Notification,
  protocol,
  shell,
  systemPreferences,
} from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { exposePolarisBridge } from "@polaris-key/node/electron";
import { createFixtureClient } from "./fixtures";

const live = process.argv.includes("--live");
const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

void (async () => {
  // Production pages load from this scheme, so the window's origin is the app's own, never file:.
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "app",
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ]);
  await app.whenReady();

  const devUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL;
  const base = devUrl ?? `app://main/index.html`;
  // PKEY_KIT_PLATFORM=windows|macos|linux forces the kit's chrome (the e2e harness uses it).
  const forced = process.env.PKEY_KIT_PLATFORM;
  const pageUrl = forced
    ? `${base}${base.includes("?") ? "&" : "?"}platform=${encodeURIComponent(forced)}`
    : base;

  if (!devUrl) {
    const root = join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`);
    protocol.handle("app", (req) => {
      const path = decodeURIComponent(new URL(req.url).pathname);
      const file = join(root, path === "/" ? "index.html" : path);
      // Nothing outside the renderer build is served.
      if (file !== root && !file.startsWith(root + sep))
        return new Response("Not found", { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });
  }

  const client = live
    ? await (await import("./live")).createLiveClient()
    : createFixtureClient();
  await client.update.markBootAttempt();

  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true, // the page cannot reach the preload's scope
      sandbox: true, // the preload is bundled, so it can run sandboxed
      nodeIntegration: false,
    },
  });

  const bridge = exposePolarisBridge(client, {
    ipcMain,
    // Only the top frame of the app's own origin may use the bridge.
    appOrigin: devUrl ? new URL(devUrl).origin : "app://main",
    // release.fetch writes only under this host-owned directory.
    downloadDir: app.getPath("downloads"),
    // Opt-in OS notifications ("update ready", "signed in"), shown only while unfocused.
    notifications: {
      Notification,
      isAppFocused: () => win.isFocused(),
      onClick: () => win.show(),
    },
    // Accent, high contrast and reduced transparency for the kit's native chrome.
    electron: { systemPreferences, nativeTheme },
    // The kit's links out (replace a device, release notes, the sign-in page): https only.
    shell,
  });

  // The kit's two menu items: in the app menu on macOS, the Help menu elsewhere.
  const items = bridge.menuItems();
  const mac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              ...items,
              { type: "separator" },
              { role: "quit" },
            ],
          } as MenuItemConstructorOptions,
        ]
      : [{ role: "fileMenu" } as MenuItemConstructorOptions]),
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    { role: "help", submenu: mac ? [] : items },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  // The window shows the app and nothing else: no popups, no navigation away. A link the page
  // opens leaves for the system browser when it is https; everything else is dropped. (The kit
  // itself asks the bridge, whose own https check and sender rule apply.)
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === "https:" && !u.username && !u.password)
        void shell.openExternal(u.href);
    } catch {
      // Not a URL: nothing opens.
    }
    return { action: "deny" };
  });
  // Compare scheme and host: `.origin` is the opaque "null" for app: and file: URLs.
  const page = new URL(pageUrl);
  const stay = (e: { preventDefault(): void }, url: string) => {
    const u = new URL(url);
    if (u.protocol !== page.protocol || u.host !== page.host)
      e.preventDefault();
  };
  win.webContents.on("will-navigate", (e, url) => stay(e, url));
  win.webContents.on("will-redirect", (e, url) => stay(e, url));
  win.once("ready-to-show", () => win.show());

  const scheme = arg("scheme");
  if (scheme === "dark" || scheme === "light") nativeTheme.themeSource = scheme;
  await win.loadURL(pageUrl);
  await client.update.confirmBoot();

  // --smoke: exit 0 once the gate is on screen. --shot=<png>: also save the window first.
  if (process.argv.includes("--smoke") || arg("shot")) {
    const gate = `document.querySelector('[data-pk-platform]')?.textContent?.trim() || ''`;
    for (let i = 0; i < 60; i++) {
      const text: string = await win.webContents.executeJavaScript(gate);
      if (text) {
        await new Promise((r) => setTimeout(r, 1200));
        const shot = arg("shot");
        if (shot)
          writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
        console.log(`SMOKE ok: ${text.slice(0, 80)}`);
        app.exit(0);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    console.error("SMOKE failed: the gate never rendered");
    app.exit(1);
  }
})().catch((e) => {
  console.error(e);
  app.exit(1);
});
