// Outlet detection — plans/P3-01.md §2.9 "Detection" and §4.7 (`outlet-matrix.json`).
//
// "Where did this install come from?" A pure, synchronous `detectOutlet(stamp:signals:)` maps the
// signals a runtime observed, and the build stamp, to `{kind, confidence, source, subkind}`.
// Every SDK holds this same function (`detect_outlet` in Python and GDScript), and
// `outlet-matrix.json`'s rows pin it in every runner (`OutletMatrixTests` here). READING the
// signals is per runtime (`readOutletSignals` in PolarisKeyUpdate); only this mapping is shared.
//
// The result never goes straight into the decision: the update client passes it to
// `resolveUpdateOutlet` as `detected` (§2.8), where a host value always wins. Detection chooses
// an outlet; it never widens what that outlet may do.
//
// No I/O, never throws. Raw signal values never leave the device.

/// One detection signal, in vocabulary order, with its confidence: nil for the two diagnostic
/// signals, which are recorded and never count (`outlet-matrix.json#/signals`).
public struct OutletSignalSpec: Sendable, Equatable {
    public let signal: String
    public let confidence: String?

    public init(_ signal: String, _ confidence: String?) {
        self.signal = signal
        self.confidence = confidence
    }
}

/// The 25 signals in vocabulary order (§4.7's table).
public let OUTLET_SIGNALS: [OutletSignalSpec] = [
    OutletSignalSpec("ios.appDistributor", "attested"),
    OutletSignalSpec("ios.bundleIdRewrite", "declared"),
    OutletSignalSpec("ios.provisioningProfile", "heuristic"),
    OutletSignalSpec("macos.masReceipt", "attested"),
    OutletSignalSpec("macos.receiptSandbox", "attested"),
    OutletSignalSpec("macos.signingLeaf", "attested"),
    OutletSignalSpec("macos.homebrewCask", "heuristic"),
    OutletSignalSpec("macos.homebrewFormula", "heuristic"),
    OutletSignalSpec("windows.packageIdentity", "attested"),
    OutletSignalSpec("windows.signatureKind", "attested"),
    OutletSignalSpec("windows.appInstallerUri", "attested"),
    OutletSignalSpec("windows.externalLocation", "attested"),
    OutletSignalSpec("windows.pathConvention", "heuristic"),
    OutletSignalSpec("linux.flatpakInfo", "attested"),
    OutletSignalSpec("linux.snapEnv", "declared"),
    OutletSignalSpec("linux.appImageEnv", "declared"),
    OutletSignalSpec("steam.libraryManifest", "declared"),
    OutletSignalSpec("steam.appIdEnv", "heuristic"),
    OutletSignalSpec("steam.appIdFile", nil),
    OutletSignalSpec("itch.receipt", "declared"),
    OutletSignalSpec("itch.appEnv", nil),
    OutletSignalSpec("android.installSource", "declared"),
    OutletSignalSpec("android.installerMismatch", "declared"),
    OutletSignalSpec("web.displayMode", "heuristic"),
    OutletSignalSpec("node.packageManager", "heuristic"),
]

/// The platform facts detection reads (`outlet-matrix.json#/platformData`, less the listing
/// prefixes, which are `LISTING_URL_PREFIXES`).
public struct OutletPlatformData: Sendable, Equatable {
    public let playStoreCertSha256s: [String]
    public let altStorePalMarketplaceIds: [String]
    public let playPackages: [String]
    public let obtainiumPackages: [String]
    public let fdroidClientPackages: [String]
    public let systemInstallerPackages: [String]
    /// The only two macOS signing leaves that select an outlet. Every other leaf vetoes.
    public let macosStoreLeaves: [String: String]
    /// The deadline for an async platform call (iOS `AppDistributor.current`), in ms.
    public let deadlineMs: Int
}

/// The values `outlet-matrix.json` fixes. The two digest and marketplace lists stay empty until
/// P5-06 and P5-05 record them.
public let OUTLET_PLATFORM_DATA = OutletPlatformData(
    playStoreCertSha256s: [],
    altStorePalMarketplaceIds: [],
    playPackages: ["com.android.vending"],
    obtainiumPackages: ["dev.imranr.obtainium", "dev.imranr.obtainium.fdroid"],
    fdroidClientPackages: ["org.fdroid.fdroid", "com.looker.droidify", "com.machiav3lli.fdroid"],
    systemInstallerPackages: ["com.google.android.packageinstaller", "com.android.packageinstaller"],
    macosStoreLeaves: [
        "Apple Mac OS Application Signing": "app-store",
        "TestFlight Beta Distribution": "testflight",
    ],
    deadlineMs: 2000)

/// The stamp as detection reads it (`outlet-matrix.json` rows' `stamp`): its outlet KIND, its
/// subkind and the product's outlet identities.
public struct DetectionStamp: Sendable, Equatable {
    public var outletKind: String
    public var subkind: String?
    public var outletIds: [String: String]

    public init(outletKind: String, subkind: String? = nil, outletIds: [String: String] = [:]) {
        self.outletKind = outletKind
        self.subkind = subkind
        self.outletIds = outletIds
    }

    /// The synthesised stamp of a web runtime (§2.9).
    public static let web = DetectionStamp(outletKind: "web")
}

/// The detection stamp of a build stamp: the kind as `resolveUpdateOutlet` reads it
/// (`outletKind`, else `outlet`; a kind outside the 17 is no kind), the subkind when it is one of
/// the 8, and its identities. Nil when the stamp names no kind.
public func detectionStamp(_ stamp: OutletStamp?) -> DetectionStamp? {
    guard let stamp else { return nil }
    guard let kind = stamp.outletKind ?? stamp.outlet, OUTLET_KIND_VALUES.contains(kind) else { return nil }
    let sub = stamp.outletSubkind.flatMap { OUTLET_SUBKIND_VALUES.contains($0) ? $0 : nil }
    return DetectionStamp(outletKind: kind, subkind: sub, outletIds: stamp.outletIds)
}

/// `{kind: "unknown", confidence: nil, source: nil, subkind: nil}`.
public let UNKNOWN_DETECTION = DetectedOutlet(kind: OUTLET_UNKNOWN)

private struct Evidence {
    let signal: String
    var confidence: String
    var names: (kind: String, subkind: String?)?
    var vetoes: [String] = []
}

/// `binaryUpdates`'s width of a kind narrowed by a subkind (no platform).
private func width(_ kind: String, _ subkind: String?) -> Int {
    BINARY_UPDATES_ORDER.firstIndex(of: effectiveCapabilities(kind, platform: "", subkind: subkind).binaryUpdates)
        ?? 0
}

/// Detect the outlet from the build stamp and the observed signals, in §2.9's five steps:
/// filter (identity conditions, diagnostics), attested naming, the stamp, vetoes, then the
/// restricting declared and heuristic signals. A malformed value is no evidence; never throws
/// (`outlet-matrix.json#/rows`).
public func detectOutlet(stamp: DetectionStamp?, signals: [String: JSONValue]) -> DetectedOutlet {
    let st = stamp.flatMap { OUTLET_KIND_VALUES.contains($0.outletKind) ? $0 : nil }
    let ids = st?.outletIds ?? [:]
    func field(_ s: String, _ key: String) -> JSONValue? { signals[s]?.objectValue?[key] }
    /// A missing identity never matches.
    func names(_ key: String, _ value: JSONValue?) -> Bool {
        guard let want = ids[key], let got = value?.stringValue else { return false }
        return got == want
    }
    func identityHolds(_ s: String) -> Bool {
        switch s {
        case "ios.bundleIdRewrite": return names("bundleId", field(s, "altBundleIdentifier"))
        case "macos.receiptSandbox": return signals["macos.masReceipt"]?.boolValue == true
        case "macos.homebrewCask": return names("caskToken", signals[s])
        case "macos.homebrewFormula": return names("homebrewFormula", signals[s])
        case "windows.packageIdentity", "windows.signatureKind", "windows.appInstallerUri",
            "windows.externalLocation":
            return names("msixFamilyName", signals["windows.packageIdentity"])
        case "linux.flatpakInfo": return names("flatpakId", signals[s])
        case "linux.snapEnv": return names("snapName", field(s, "name"))
        case "linux.appImageEnv":
            guard let exe = field(s, "exePath")?.stringValue, let dir = field(s, "appDir")?.stringValue
            else { return false }
            return exe.hasPrefix(dir)
        case "steam.libraryManifest": return names("steamAppId", signals[s])
        case "steam.appIdEnv": return names("steamAppId", field(s, "appId"))
        case "itch.receipt": return names("itchGameId", signals[s])
        case "android.installSource":
            guard let installer = field(s, "installer"), let initiator = field(s, "initiator")
            else { return false }
            switch (installer, initiator) {
            case (.null, .null): return true
            case (.string(let a), .string(let b)): return a == b
            default: return false
            }
        case "node.packageManager": return field(s, "packageMatch")?.boolValue == true
        default: return true
        }
    }

    let data = OUTLET_PLATFORM_DATA
    var evidence: [Evidence] = []
    // 1. Filter, and read each surviving signal's effect.
    for spec in OUTLET_SIGNALS {
        guard let confidence = spec.confidence, let value = signals[spec.signal], identityHolds(spec.signal)
        else { continue }
        var e = Evidence(signal: spec.signal, confidence: confidence)
        switch spec.signal {
        case "ios.appDistributor":
            switch value.stringValue {
            case "appStore": e.names = ("app-store", nil)
            case "testFlight": e.names = ("testflight", nil)
            case "web": e.names = ("direct", nil)
            case let v? where v.hasPrefix("marketplace:"):
                if data.altStorePalMarketplaceIds.contains(String(v.dropFirst("marketplace:".count))) {
                    e.names = ("altstore-pal", nil)
                } else {
                    e.vetoes = ["app-store", "testflight"]
                }
            default: break  // `other` and `timeout` are no evidence
            }
        case "ios.bundleIdRewrite": e.names = ("altstore", nil)
        case "ios.provisioningProfile": if value.boolValue == true { e.vetoes = ["app-store"] }
        case "macos.masReceipt":
            if value.boolValue == true {
                e.names = (signals["macos.receiptSandbox"]?.boolValue == true ? "testflight" : "app-store", nil)
            }
        case "macos.signingLeaf":
            if let leaf = value.stringValue, let kind = data.macosStoreLeaves[leaf] {
                e.names = (kind, nil)
            } else {
                e.vetoes = ["app-store", "testflight"]
            }
        case "macos.homebrewCask", "macos.homebrewFormula": e.names = ("direct", "homebrew")
        case "windows.signatureKind":
            switch value.stringValue {
            case "Store": e.names = ("ms-store", nil)
            case "Developer", "Enterprise": e.vetoes = ["ms-store"]
            default: break
            }
        case "windows.appInstallerUri": if value != .null { e.names = ("app-installer", nil) }
        case "windows.pathConvention":
            switch value.stringValue {
            case "winget": e.names = ("winget", nil)
            case "scoop": e.names = ("direct", "scoop")
            case "chocolatey": e.names = ("direct", "chocolatey")
            default: break
            }
        case "linux.flatpakInfo":
            e.names = st?.outletKind == "direct" && st?.subkind == "flatpak" ? ("direct", "flatpak") : ("flathub", nil)
        case "linux.snapEnv":
            if let rev = field(spec.signal, "revision")?.stringValue, rev.hasPrefix("x") {
                e.vetoes = ["snap"]
            } else {
                e.names = ("snap", nil)
            }
        case "linux.appImageEnv": e.names = ("direct", "appimage")
        case "steam.libraryManifest", "steam.appIdEnv": e.names = ("steam", nil)
        case "itch.receipt": e.names = ("itch", nil)
        case "android.installSource":
            let installer = field(spec.signal, "installer")
            if let i = installer?.stringValue, data.playPackages.contains(i) {
                e.names = ("play", nil)
                if let digest = field(spec.signal, "initiatorCertSha256")?.stringValue,
                    data.playStoreCertSha256s.contains(digest)
                {
                    e.confidence = "attested"
                }
            } else if let i = installer?.stringValue, data.obtainiumPackages.contains(i) {
                e.names = ("obtainium", nil)
            } else if let i = installer?.stringValue, data.fdroidClientPackages.contains(i) {
                e.names = ("fdroid-repo", nil)
            } else if installer == .null || installer?.stringValue == "com.android.shell"
                || installer?.stringValue.map(data.systemInstallerPackages.contains) == true
            {
                e.names = ("direct", nil)
            }
        case "android.installerMismatch": if value.boolValue == true { e.vetoes = ["play", "play-testing"] }
        case "web.displayMode": e.names = ("web", nil)
        case "node.packageManager":
            if let m = field(spec.signal, "manager")?.stringValue, ["npm", "pnpm", "npx"].contains(m) {
                e.names = ("direct", m)
            }
        default: break
        }
        evidence.append(e)
    }
    func vetoed(_ kind: String) -> Bool { evidence.contains { $0.vetoes.contains(kind) } }

    // 2. Attested naming.
    let attested = evidence.filter { $0.confidence == "attested" && $0.names != nil }
    if let first = attested.first, let named = first.names {
        if attested.contains(where: { $0.names?.kind != named.kind }) { return UNKNOWN_DETECTION }
        if vetoed(named.kind) { return UNKNOWN_DETECTION }
        return DetectedOutlet(kind: named.kind, confidence: "attested", source: first.signal, subkind: named.subkind)
    }

    // 3. The stamp.
    guard let st else { return UNKNOWN_DETECTION }
    let curSub = st.subkind.flatMap { OUTLET_SUBKIND_VALUES.contains($0) ? $0 : nil }

    // 4. Vetoes.
    if vetoed(st.outletKind) { return UNKNOWN_DETECTION }

    // 5. Restricting signals: declared, then heuristic, each in vocabulary order.
    let ceiling = width(st.outletKind, curSub)
    for conf in ["declared", "heuristic"] {
        for e in evidence where e.confidence == conf {
            guard let named = e.names, width(named.kind, named.subkind) <= ceiling else { continue }
            return DetectedOutlet(
                kind: named.kind, confidence: conf, source: e.signal,
                subkind: named.subkind ?? (named.kind == st.outletKind ? curSub : nil))
        }
    }
    return DetectedOutlet(kind: st.outletKind, confidence: "stamp", source: "stamp", subkind: curSub)
}
