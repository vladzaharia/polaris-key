/**
 * Names a covered page may write in a code span without them being SDK exports: the platform's own
 * types (SwiftUI, Compose, the Godot engine) and the reader's own names. Add a name here only when it
 * is not Polaris Key's; a Polaris Key name that does not exist belongs in prose with "planned".
 */

import type { NativeLang } from "./nativeLanes";

export const IGNORED: Record<NativeLang, Set<string>> = {
  swift: new Set([
    // SwiftPM products and modules, not symbols.
    "PolarisKey",
    "PolarisKeyUI",
    "PolarisKeyUICore",
    "PolarisKeyUpdate",
    "PolarisKeyPacks",
    "PolarisKeyCore",
    "PolarisKeyConfig",
    "PolarisKeyLicense",
    "PolarisKeyIdentity",
    "PolarisKeyRelease",
    "PolarisKeyPlatform",
    "WindowGroup",
    "ObservableObject",
    "AsyncStream",
    "AsyncSequence",
    "ASWebAuthenticationSession",
    "MainActor",
    "UserDefaults",
    "NavigationStack",
    "PackageDescription",
    "SwiftUI",
    "UIKit",
    "AppKit",
    "XCTest",
    "XcodeGen",
    "StoreKit",
    "CryptoKit",
    "UIApplicationDelegate",
    "NSApplicationDelegate",
    "SPUUserDriver",
    "SPUUpdater",
    "ButtonStyle", // a SwiftUI type, not Polaris Key's
    "LocalizedError", // the Swift standard library's
    "FileManager",
    "PublicKey", // CryptoKit's `Curve25519.Signing.PublicKey`
    "canImport", // a Swift compilation condition
    "PolarisKeyPlatformC", // a SwiftPM product, not a symbol
    // Apple platform names the README's platform sections cite.
    "ProductionSandbox",
    "SecCodeCopySigningInformation",
    "AfterFirstUnlock",
    "AfterFirstUnlockThisDeviceOnly",
    "AssetPackManager",
    // The names `pkey sdk` generates into the reader's own project (the config enum and its options).
    "PolarisConfig",
    "clientOptions",
  ]),
  kotlin: new Set([
    // The names `pkey sdk` generates into the reader's own project (the config object and its options).
    "PolarisConfig",
    "clientOptions",
    "CompletableFuture", // a JDK type
    "StateFlow",
    "SharedFlow",
    "MaterialTheme",
    "LaunchedEffect",
    "JsonPrimitive",
    "BuildConfig",
    "StrictMode",
    "CoroutineScope",
    "ViewModel",
    "Application",
    "ComponentActivity",
    "OkHttp",
    "OkHttpClient",
    "SafeVarargs",
    "AndroidManifest",
    "GradleBuildScript",
    "ProGuard",
    "JetBrains",
    // Other vendors' types the README names: Google Play, Play Integrity, Steamworks.
    "GetAuthTicketForWebApi",
    "PurchasesUpdatedListener",
    "InstallException",
    "StandardIntegrityManager",
    "StandardIntegrityErrorCode",
    "FakeAppUpdateManager",
    // Swift's module, the generated mirror in a reader's project, and a test base class.
    "PolarisKeyCore",
    "ProductCatalog",
    "ConformanceSuite",
  ]),
  gdscript: new Set([
    "PackedStringArray",
    "ProjectSettings",
    "ConfigFile",
    "SceneTree",
    "PackedScene",
    "EditorPlugin",
    "AssetLib",
    "GodotEnv",
    "StringName",
    // Godot engine API (Node, Control, Dictionary, String, OS), not Polaris Key's.
    "get_display_safe_area",
    "set_anchors_and_offsets_preset",
    "set_meta",
    "get_space_left",
    "get_error",
    "simplify_path",
    "to_native",
  ]),
};
