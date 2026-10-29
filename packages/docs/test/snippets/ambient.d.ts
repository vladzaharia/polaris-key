// App-side names a TypeScript docs block may use without declaring them (PLACEHOLDERS in
// extract.ts), and the one host module the blocks import that the docs do not depend on.

declare const APP_VERSION: string;
declare const userEnteredKey: string;
declare const pinnedKeys: Record<string, string>;
declare const client: import("@polaris-key/node").PolarisKeyClient;
declare const appResources: string;
declare const render: (state: unknown) => void;
declare const showActivation: () => void;
declare const YourApp: () => import("react").JSX.Element;

/** The slice of Electron the Node SDK's bridge docs use. */
declare module "electron" {
  export const app: {
    whenReady(): Promise<void>;
    getPath(name: "userData" | "downloads"): string;
    getVersion(): string;
    name: string;
    quit(): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
  };
  export const ipcMain: {
    handle(
      channel: string,
      listener: (event: any, ...args: any[]) => unknown,
    ): void;
    removeHandler(channel: string): void;
  };
  export const safeStorage: {
    isEncryptionAvailable(): boolean;
    encryptString(text: string): Buffer;
    decryptString(data: Buffer): string;
  };
  export class BrowserWindow {
    constructor(options?: {
      width?: number;
      height?: number;
      webPreferences?: {
        preload?: string;
        sandbox?: boolean;
        contextIsolation?: boolean;
      };
    });
    loadURL(url: string): Promise<void>;
    loadFile(path: string): Promise<void>;
    isFocused(): boolean;
    show(): void;
    webContents: {
      setWindowOpenHandler(
        handler: (details: { url: string }) => { action: "allow" | "deny" },
      ): void;
    };
  }
  export const shell: {
    openExternal(url: string): Promise<void>;
  };
  export class Notification {
    constructor(options: { title: string; body: string });
    static isSupported(): boolean;
    show(): void;
    on(event: "click" | "close", listener: () => void): this;
  }
  export const Menu: {
    buildFromTemplate(template: unknown[]): unknown;
    setApplicationMenu(menu: unknown): void;
  };
}
