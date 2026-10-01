// Platform directories for one product: config (unchanged), data, cache and state (P1b-09 plan
// §5.4). Mirrors `packages/sdk-node/src/core/dirs.ts` and `polaris_key/core/dirs.py`.
//
// Every option is a BASE and the SDK appends `<product>`, exactly as `configDir` has always
// worked. The config base does NOT move: it holds the device id and `managed.json`, and a
// developer's Node, Python and Swift tools share it, so moving it without a migration in all
// three SDKs at once would lose state (plan D5). The three new bases live under a `polaris-key`
// vendor segment so they cannot collide with the host application's own folder (plan D6).
//
// Resolution is PURE: nothing here creates a directory. `excludeFromBackup` is the one helper
// with a side effect, and it never throws.

import Foundation

/// The four directories of one product. Each already ends in `<product>`.
public struct ProductDirs: Sendable, Equatable {
    public let config: URL
    public let data: URL
    public let cache: URL
    public let state: URL

    public init(config: URL, data: URL, cache: URL, state: URL) {
        self.config = config
        self.data = data
        self.cache = cache
        self.state = state
    }

    /// The roots resolution reads from the system, injectable so every platform's table can be
    /// tested on any host.
    public struct Roots: Sendable, Equatable {
        /// The config BASE (macOS `~/.config`; iOS Application Support).
        public let config: URL
        /// `FileManager`'s Application Support directory (the container's inside a sandbox).
        public let applicationSupport: URL
        /// `FileManager`'s Caches directory.
        public let caches: URL

        public init(config: URL, applicationSupport: URL, caches: URL) {
            self.config = config
            self.applicationSupport = applicationSupport
            self.caches = caches
        }

        /// This process's roots.
        public static func system() -> Roots {
            let fm = FileManager.default
            let support =
                fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? fm.temporaryDirectory
            let caches =
                fm.urls(for: .cachesDirectory, in: .userDomainMask).first ?? fm.temporaryDirectory
            return Roots(
                config: ProductDirs.defaultConfigBase(), applicationSupport: support,
                caches: caches)
        }
    }

    private static let vendor = "polaris-key"

    /// Where the device id and cache live when the host does not say (unchanged by P1b-09).
    ///
    /// `~/.config/` on macOS, matching the Node SDK's `XDG_CONFIG_HOME ?? ~/.config`, so a
    /// developer running both against the same product finds one directory rather than two.
    /// `homeDirectoryForCurrentUser` is UNAVAILABLE on iOS, so iOS uses Application Support, the
    /// sandboxed equivalent, and falls back to the temporary directory only on a platform that
    /// has neither.
    public static func defaultConfigBase() -> URL {
        #if os(macOS)
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config", isDirectory: true)
        #else
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first ?? FileManager.default.temporaryDirectory
        #endif
    }

    /// The default BASES (before `<product>` is appended).
    public static func defaultBases(roots: Roots = .system()) -> ProductDirs {
        let support = roots.applicationSupport.appendingPathComponent(vendor, isDirectory: true)
        return ProductDirs(
            config: roots.config,
            data: support.appendingPathComponent("data", isDirectory: true),
            cache: roots.caches.appendingPathComponent(vendor, isDirectory: true),
            state: support.appendingPathComponent("state", isDirectory: true))
    }

    /// Each override base, else the platform default, with `<product>` appended. Creates
    /// nothing.
    public static func resolve(
        productSlug: String,
        configDir: URL? = nil,
        dataDir: URL? = nil,
        cacheDir: URL? = nil,
        stateDir: URL? = nil,
        roots: Roots = .system()
    ) -> ProductDirs {
        let bases = defaultBases(roots: roots)
        func product(_ base: URL) -> URL {
            base.appendingPathComponent(productSlug, isDirectory: true)
        }
        return ProductDirs(
            config: product(configDir ?? bases.config),
            data: product(dataDir ?? bases.data),
            cache: product(cacheDir ?? bases.cache),
            state: product(stateDir ?? bases.state))
    }

    /// What `excludeFromBackup` did.
    public enum BackupExclusion: String, Sendable, Equatable {
        case excluded
        case notApplicable = "not-applicable"
        case failed
    }

    /// The `CACHEDIR.TAG` signature line, which tar, borg and restic skip under
    /// `--exclude-caches` (https://bford.info/cachedir/).
    public static let cachedirTagSignature = "Signature: 8a477f597d28d172789f06886806bc55"

    /// Mark an EXISTING directory (the caller creates it first, at 0700) as excluded from
    /// backups: `isExcludedFromBackup` on every Apple platform, plus a `CACHEDIR.TAG` on macOS.
    /// Never throws: `.failed` when any step fails.
    public static func excludeFromBackup(_ url: URL) -> BackupExclusion {
        do {
            var target = url
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try target.setResourceValues(values)
            #if os(macOS)
            let tag = url.appendingPathComponent("CACHEDIR.TAG")
            if !FileManager.default.fileExists(atPath: tag.path) {
                let body =
                    "\(cachedirTagSignature)\n"
                    + "# This file is a cache directory tag created by Polaris Key.\n"
                    + "# For information about cache directory tags, see https://bford.info/cachedir/\n"
                try Data(body.utf8).write(to: tag, options: .withoutOverwriting)
            }
            #endif
            return .excluded
        } catch {
            return .failed
        }
    }
}
