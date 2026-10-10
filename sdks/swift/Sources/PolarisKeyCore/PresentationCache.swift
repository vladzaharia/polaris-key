// The product's presentation as the SDK keeps it (plans/HA-13.md §3, the shared rules): the
// `PresentationSource` every kit reads, over discovery and a small icon cache.
//
//   current()            the last parsed member, or nil
//   icon(px:scale:)      the verified icon's bytes for a hero `px` points wide on a `scale`
//                        screen, or nil (the kit then shows the bundle's icon or a monogram)
//   subscribe(_:)        the member changed (nil when it went away)
//
// `CoreContext` owns one. After every successful discovery the member is parsed again
// (`ProductDiscoveryDocument.presentation`): a document without one (or with an invalid one)
// clears it, and a failed discovery keeps the last. `start()` loads the last member from
// `presentation.json` through the same parser, so an offline start still shows the product and a
// tampered file is dropped.
//
// **Fetch.** `URLSessionIconFetcher`: an ephemeral session with no cookies, cache or credential
// store, a plain GET with no `Authorization` or `X-PKey-*` header (the image host is public),
// every redirect refused (a 3xx is a miss), 200 only, PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS for
// the whole exchange and PRESENTATION_ICON_MAX_BYTES for the body. The URL must be https (or
// loopback http) and on the original's origin. Nothing is retried and no error is surfaced. A
// local-only client has no fetcher at all.
//
// **Verify.** Bytes are shown and cached only when their SHA-256 is the pick's. Where ImageIO is
// present, the header's dimensions are then read without decoding: above
// PRESENTATION_ICON_MAX_DIMENSION a side, or above a 16-megapixel budget, the bytes are refused,
// since a 10 MiB file can inflate to gigabytes in the kit's decoder.
//
// **Cache.** `<data>/presentation/<sha256>` and the last member as `presentation.json` beside it
// (`{"v": 1, "product", "presentation"}`), each written atomically. A cached file is re-hashed on
// every read and deleted on a mismatch. After each discovery the files the member no longer names
// are removed, keeping at most PRESENTATION_CACHE_MAX_FILES icon files, oldest first. Nothing
// enters the Core cache record.

import Foundation

#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif
#if canImport(ImageIO)
    import ImageIO
    import UniformTypeIdentifiers
#endif

/// One icon response: the status and, for a 200, the whole body.
public struct PresentationIconResponse: Sendable, Equatable {
    public let status: Int
    public let body: Data

    public init(status: Int, body: Data) {
        self.status = status
        self.body = body
    }
}

/// How the presentation source fetches icon bytes. The default is `URLSessionIconFetcher`.
public protocol PresentationIconFetcher: Sendable {
    /// GET `url` with no credential and no redirect: the response, or nil when none arrived in
    /// `timeoutSeconds` or its body would pass `maxBytes`.
    func fetch(_ url: URL, timeoutSeconds: Double, maxBytes: Int) async -> PresentationIconResponse?
}

/// The icon fetcher over an ephemeral `URLSession` (see the file header).
public struct URLSessionIconFetcher: PresentationIconFetcher {
    private let session: URLSession

    /// No cookies, no cache, no credential store, no extra headers.
    public static func makeConfiguration() -> URLSessionConfiguration {
        let c = URLSessionConfiguration.ephemeral
        c.httpShouldSetCookies = false
        c.httpCookieAcceptPolicy = .never
        c.httpCookieStorage = nil
        c.urlCache = nil
        c.urlCredentialStorage = nil
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.httpAdditionalHeaders = nil
        return c
    }

    public init(configuration: URLSessionConfiguration = URLSessionIconFetcher.makeConfiguration())
    {
        self.session = URLSession(configuration: configuration)
    }

    public func fetch(_ url: URL, timeoutSeconds: Double, maxBytes: Int) async
        -> PresentationIconResponse?
    {
        #if canImport(FoundationNetworking)
            // No per-task redirect control here: no icon rather than a followed redirect.
            return nil
        #else
            let session = self.session
            return await withTaskGroup(of: PresentationIconResponse?.self) { group in
                group.addTask { await Self.load(url, session: session, maxBytes: maxBytes) }
                group.addTask {
                    try? await Task.sleep(nanoseconds: UInt64(max(0, timeoutSeconds) * 1e9))
                    return nil
                }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first
            }
        #endif
    }

    #if !canImport(FoundationNetworking)
        private static func load(_ url: URL, session: URLSession, maxBytes: Int) async
            -> PresentationIconResponse?
        {
            var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
            request.httpMethod = "GET"
            request.httpShouldHandleCookies = false
            let refuse = RefuseRedirects()
            do {
                let (bytes, response) = try await session.bytes(for: request, delegate: refuse)
                guard let http = response as? HTTPURLResponse else {
                    bytes.task.cancel()
                    return nil
                }
                guard http.statusCode == 200, !refuse.redirected.current else {
                    bytes.task.cancel()
                    return PresentationIconResponse(status: http.statusCode, body: Data())
                }
                if response.expectedContentLength > Int64(maxBytes) {
                    bytes.task.cancel()
                    return nil
                }
                var body = Data()
                if response.expectedContentLength > 0 {
                    body.reserveCapacity(Int(response.expectedContentLength))
                }
                for try await byte in bytes {
                    body.append(byte)
                    if body.count > maxBytes {
                        bytes.task.cancel()
                        return nil
                    }
                }
                return PresentationIconResponse(status: 200, body: body)
            } catch {
                return nil
            }
        }
    #endif
}

/// Refuses every redirect: the 3xx itself becomes the response, and anything but 200 is a miss.
final class RefuseRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    let redirected = LockedValue(false)

    func urlSession(
        _ session: URLSession, task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        redirected.set(true)
        completionHandler(nil)
    }
}

/// The SDK's `PresentationSource`: discovery's member, `presentation.json` and the icon cache.
public final class ProductPresentationSource: PresentationSource, @unchecked Sendable {
    /// The member's file beside the icons.
    public static let memberFile = "presentation.json"
    /// `presentation.json`'s format version.
    public static let memberFileVersion = 1
    /// The decode budget, in pixels: a local guard (not a wire limit). 16384 × 16384 RGBA is 1 GiB.
    public static let decodeBudgetPixels = 16 * 1024 * 1024

    /// The product the member belongs to.
    public let product: String
    /// Where the icons and `presentation.json` live.
    public let directory: URL
    /// The content types this platform decodes (`defaultDecodable`).
    public let decodable: Set<String>
    /// Nil on a local-only client: then nothing is ever fetched.
    private let fetcher: (any PresentationIconFetcher)?

    private struct State {
        var current: Presentation?
        var discovered = false
        var listeners: [UUID: @Sendable (Presentation?) -> Void] = [:]
        var memo: [String: Data] = [:]
        var pending: [String: Task<Data?, Never>] = [:]
    }

    private let state = LockedValue(State())
    /// Serialises the file work (writes, prunes, reads) of this source.
    private let files = NSLock()

    public init(
        product: String, directory: URL, fetcher: (any PresentationIconFetcher)?,
        decodable: Set<String> = ProductPresentationSource.defaultDecodable
    ) {
        self.product = product
        self.directory = directory
        self.fetcher = fetcher
        self.decodable = decodable
    }

    /// The icon types ImageIO decodes on this OS, among `PRESENTATION_ICON_TYPES`.
    public static let defaultDecodable: Set<String> = {
        #if canImport(ImageIO)
            var out: Set<String> = []
            let identifiers = (CGImageSourceCopyTypeIdentifiers() as? [String]) ?? []
            for id in identifiers {
                if let mime = UTType(id)?.preferredMIMEType, PRESENTATION_ICON_TYPES.contains(mime) {
                    out.insert(mime)
                }
            }
            return out.isEmpty ? ["image/png", "image/jpeg"] : out
        #else
            return []
        #endif
    }()

    // ── PresentationSource ────────────────────────────────────────────────────────────────

    public func current() -> Presentation? { state.current.current }

    public func subscribe(_ onChange: @escaping @Sendable (Presentation?) -> Void)
        -> @Sendable () -> Void
    {
        let id = UUID()
        state.with { $0.listeners[id] = onChange }
        return { [weak self] in
            _ = self?.state.with { $0.listeners.removeValue(forKey: id) }
        }
    }

    /// The verified icon for a hero drawn at `px` points on a `scale` screen, or nil: no member,
    /// no icon, nothing decodable, or a fetch or hash that failed. Concurrent calls for the same
    /// bytes share one fetch.
    public func icon(px: Double, scale: Double = 1) async -> Data? {
        guard let icon = current()?.icon else { return nil }
        let pick = PresentationRules.pickIconSize(
            icon, px: px, scale: scale, decodable: decodable)
        guard let sha = pick.sha256, let url = pick.url else { return nil }
        enum Lookup {
            case hit(Data)
            case wait(Task<Data?, Never>)
        }
        let lookup: Lookup = state.with { s in
            if let hit = s.memo[sha] { return .hit(hit) }
            if let pending = s.pending[sha] { return .wait(pending) }
            let task = Task { [weak self] () -> Data? in
                await self?.load(sha: sha, url: url, original: icon.original)
            }
            s.pending[sha] = task
            return .wait(task)
        }
        switch lookup {
        case .hit(let data):
            return data
        case .wait(let task):
            let data = await task.value
            state.with { s in
                s.pending.removeValue(forKey: sha)
                // Kept only while the current member still names it.
                if let data, s.current?.iconHashes.contains(sha) == true { s.memo[sha] = data }
            }
            return data
        }
    }

    // ── Discovery ────────────────────────────────────────────────────────────────────────────

    /// Cold start: the last member from `presentation.json`, unless this session already
    /// discovered one. A file that does not parse, names another product, or does not read back
    /// exactly as the parser normalises it is deleted.
    public func loadCached() {
        if state.current.discovered { return }
        guard let member = readMember() else { return }
        let changed = state.with { s -> Bool in
            guard !s.discovered else { return false }
            return Self.swap(&s, member)
        }
        if changed { emit(member) }
    }

    /// A successful discovery's member (nil when it carries none): store, prune, then tell the
    /// subscribers when it changed.
    public func accept(_ member: Presentation?) {
        let changed = state.with { s -> Bool in
            s.discovered = true
            return Self.swap(&s, member)
        }
        writeMember(member)
        prune(member)
        if changed { emit(member) }
    }

    private static func swap(_ s: inout State, _ member: Presentation?) -> Bool {
        guard s.current != member else { return false }
        s.current = member
        let keep = member?.iconHashes ?? []
        s.memo = s.memo.filter { keep.contains($0.key) }
        return true
    }

    private func emit(_ member: Presentation?) {
        for listener in state.current.listeners.values { listener(member) }
    }

    // ── Load ─────────────────────────────────────────────────────────────────────────────────

    /// The disk cache (re-hashed), else the network; verified, then cached.
    private func load(sha: String, url: String, original: String) async -> Data? {
        let path = directory.appendingPathComponent(sha)
        if let held = readFile(path) {
            if PresentationRules.iconMatches(held, sha256: sha), Self.withinBudget(held) {
                return held
            }
            // Tampered or truncated: gone, and fetched again below.
            removeFile(path)
        }
        guard let fetcher, PresentationRules.safeFetchUrl(url, original: original),
            let target = URL(string: url)
        else { return nil }
        guard
            let response = await fetcher.fetch(
                target, timeoutSeconds: Double(PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS),
                maxBytes: PRESENTATION_ICON_MAX_BYTES),
            response.status == 200, response.body.count <= PRESENTATION_ICON_MAX_BYTES,
            PresentationRules.iconMatches(response.body, sha256: sha),
            Self.withinBudget(response.body)
        else { return nil }
        if write(sha, response.body) { capFiles(fresh: sha) }
        return response.body
    }

    /// Whether the image's header dimensions are within PRESENTATION_ICON_MAX_DIMENSION a side and
    /// `decodeBudgetPixels` in all, read without decoding. Bytes ImageIO cannot read pass: the
    /// kit's decoder then fails on them and shows its fallback.
    static func withinBudget(_ bytes: Data) -> Bool {
        #if canImport(ImageIO)
            guard let source = CGImageSourceCreateWithData(bytes as CFData, nil),
                let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                let width = (props[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
                let height = (props[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue
            else { return true }
            return width >= 1 && height >= 1 && width <= PRESENTATION_ICON_MAX_DIMENSION
                && height <= PRESENTATION_ICON_MAX_DIMENSION
                && width * height <= decodeBudgetPixels
        #else
            return true
        #endif
    }

    // ── Cache files ──────────────────────────────────────────────────────────────────────────

    /// The icon files in the cache, by name.
    public func cachedFiles() -> [String] {
        files.withLock { iconFiles().map(\.name) }
    }

    /// Remove every icon file `member` does not name (and anything else in the directory but
    /// `presentation.json`), then keep at most PRESENTATION_CACHE_MAX_FILES of the rest.
    public func prune(_ member: Presentation?) {
        let keep = member?.iconHashes ?? []
        files.withLock {
            let fm = FileManager.default
            let names = (try? fm.contentsOfDirectory(atPath: directory.path)) ?? []
            for name in names where name != Self.memberFile && !keep.contains(name) {
                try? fm.removeItem(at: directory.appendingPathComponent(name))
            }
        }
        capFiles(fresh: nil)
    }

    private struct IconFile {
        let name: String
        let modified: Date
    }

    /// Caller holds `files`.
    private func iconFiles() -> [IconFile] {
        let fm = FileManager.default
        let names = (try? fm.contentsOfDirectory(atPath: directory.path)) ?? []
        return names.filter { $0 != Self.memberFile && !$0.hasPrefix(".") }.map { name in
            let attrs = try? fm.attributesOfItem(atPath: directory.appendingPathComponent(name).path)
            return IconFile(name: name, modified: (attrs?[.modificationDate] as? Date) ?? .distantPast)
        }
    }

    /// At most PRESENTATION_CACHE_MAX_FILES icon files: the oldest go first; `fresh` (just
    /// written) never does.
    private func capFiles(fresh: String?) {
        files.withLock {
            let others = iconFiles().filter { $0.name != fresh }
            let room = PRESENTATION_CACHE_MAX_FILES - (fresh == nil ? 0 : 1)
            guard others.count > room else { return }
            let oldestFirst = others.sorted {
                $0.modified < $1.modified || ($0.modified == $1.modified && $0.name < $1.name)
            }
            for f in oldestFirst.prefix(others.count - room) {
                try? FileManager.default.removeItem(at: directory.appendingPathComponent(f.name))
            }
        }
    }

    private func readFile(_ url: URL) -> Data? {
        files.withLock { try? Data(contentsOf: url) }
    }

    private func removeFile(_ url: URL) {
        files.withLock { _ = try? FileManager.default.removeItem(at: url) }
    }

    /// Write `bytes` to `name` atomically (a temporary file renamed over the target).
    @discardableResult
    private func write(_ name: String, _ bytes: Data) -> Bool {
        files.withLock {
            do {
                try FileManager.default.createDirectory(
                    at: directory, withIntermediateDirectories: true)
                try bytes.write(to: directory.appendingPathComponent(name), options: .atomic)
                return true
            } catch {
                return false
            }
        }
    }

    private func writeMember(_ member: Presentation?) {
        guard let member else {
            removeFile(directory.appendingPathComponent(Self.memberFile))
            return
        }
        let record: JSONValue = .object([
            "v": .int(Self.memberFileVersion), "product": .string(product),
            "presentation": member.jsonValue,
        ])
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(record) else { return }
        write(Self.memberFile, data)
    }

    private func readMember() -> Presentation? {
        let path = directory.appendingPathComponent(Self.memberFile)
        guard let data = readFile(path) else { return nil }
        var member: Presentation?
        if case .object(let o)? = try? JSONDecoder().decode(JSONValue.self, from: data),
            o["v"] == .int(Self.memberFileVersion), o["product"] == .string(product),
            !product.isEmpty, let stored = o["presentation"]
        {
            let parsed = PresentationRules.parsePresentation(
                core: .object(["presentation": stored]), docName: nil, product: product)
            // Only a member this SDK wrote reads back: the parser's normal form, exactly.
            if let parsed, parsed.jsonValue == stored { member = parsed }
        }
        if member == nil { removeFile(path) }
        return member
    }
}
