// App-side names a TypeScript docs block may use without declaring them (PLACEHOLDERS in
// extract.ts), and the one host module the blocks import that the docs do not depend on.

declare const APP_VERSION: string;
declare const userEnteredKey: string;
declare const YourApp: () => import("react").JSX.Element;

/** The slice of Electron the Node SDK's bridge docs use. */
declare module "electron" {
  export const app: {
    whenReady(): Promise<void>;
    getPath(name: "userData"): string;
    getVersion(): string;
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
  }
}
