/**
 * Names a covered page may write in a code span without them being SDK exports: the platform's own
 * types (SwiftUI, Compose, the Godot engine) and the reader's own names. Add a name here only when it
 * is not Polaris Key's; a Polaris Key name that does not exist belongs in prose with "planned".
 */

import type { NativeLang } from "./nativeLanes";

export const IGNORED: Record<NativeLang, Set<string>> = {
  swift: new Set([
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
  ]),
  kotlin: new Set([
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
  ]),
};
