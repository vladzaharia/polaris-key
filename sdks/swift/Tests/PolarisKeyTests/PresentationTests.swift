// @pkey-feature core.presentation
// The Swift port of client-core's presentation rules (plans/HA-13.md): every row of
// conformance/corpus/v2/presentation-matrix.json (read in place through `CorpusLocator`), then the
// edges the corpus cannot carry, the icon fetch rules (no credential, no redirect, 200 only, the
// deadline and the byte cap), the cache (by hash, re-hashed on read, pruned to
// PRESENTATION_CACHE_MAX_FILES), `presentation.json` for cold starts, and the client's accessor.

import CryptoKit
import Foundation
import PolarisKey
import XCTest

@testable import PolarisKeyCore

// ── The matrix ───────────────────────────────────────────────────────────────────────────────

struct PresentationMatrixFile: Decodable {
    struct ParseCase: Decodable {
        let name: String
        let core: JSONValue?
        let doc: JSONValue
        let expect: JSONValue
    }

    struct PickCase: Decodable {
        let name: String
        let icon: JSONValue
        let px: JSONValue
        let scale: JSONValue
        let decodable: [String]
        let expect: JSONValue
    }

    struct VerifyCase: Decodable {
        let name: String
        let bytes: String
        let sha256: String
        let expect: Bool
    }

    let presentationMatrixVersion: Int
    let parseCases: [ParseCase]
    let pickCases: [PickCase]
    let verifyCases: [VerifyCase]

    static func load() throws -> PresentationMatrixFile {
        let url = CorpusLocator.corpusDir.appendingPathComponent("presentation-matrix.json")
        return try JSONDecoder().decode(PresentationMatrixFile.self, from: Data(contentsOf: url))
    }
}

/// A pick case's icon, taken as written (it is already in the parser's normal form).
func presentationIcon(_ v: JSONValue) throws -> PresentationIcon {
    guard case .object(let o) = v, let sha = o["sha256"]?.stringValue,
        let type = o["contentType"]?.stringValue, let original = o["original"]?.stringValue
    else { throw NSError(domain: "matrix", code: 1) }
    let sizes = (o["sizes"]?.arrayValue ?? []).compactMap { s -> PresentationIconSize? in
        guard let w = s.objectValue?["w"]?.intValue, let h = s.objectValue?["sha256"]?.stringValue
        else { return nil }
        return PresentationIconSize(w: w, sha256: h)
    }
    return PresentationIcon(
        sha256: sha, contentType: type, width: o["width"]?.intValue, height: o["height"]?.intValue,
        original: original, url: o["url"]?.stringValue, sizes: sizes)
}

final class PresentationMatrixTests: XCTestCase {
    func testTheMatrixIsVersionOneAndNonTrivial() throws {
        let m = try PresentationMatrixFile.load()
        XCTAssertEqual(m.presentationMatrixVersion, PRESENTATION_MATRIX_VERSION)
        XCTAssertGreaterThan(m.parseCases.count, 50)
        XCTAssertGreaterThan(m.pickCases.count, 15)
        XCTAssertGreaterThanOrEqual(m.verifyCases.count, 4)
    }

    func testEveryParseCase() throws {
        for c in try PresentationMatrixFile.load().parseCases {
            let doc = c.doc.objectValue ?? [:]
            let product = doc["product"]?.stringValue ?? ""
            let got = PresentationRules.parsePresentation(
                core: c.core, docName: doc["name"], product: product)
            XCTAssertEqual(got?.jsonValue ?? .null, c.expect, "parse: \(c.name)")
            // The fixed point: what the Worker emits, every SDK re-parses to itself.
            if let got {
                XCTAssertEqual(
                    PresentationRules.parsePresentation(
                        core: .object(["presentation": got.jsonValue]), docName: doc["name"],
                        product: product), got, "re-parse: \(c.name)")
            }
        }
    }

    func testEveryPickCase() throws {
        for c in try PresentationMatrixFile.load().pickCases {
            let pick = PresentationRules.pickIconSize(
                try presentationIcon(c.icon), px: c.px.doubleValue ?? .nan,
                scale: c.scale.doubleValue ?? .nan, decodable: c.decodable)
            XCTAssertEqual(pick.jsonValue, c.expect, "pick: \(c.name)")
        }
    }

    func testEveryVerifyCase() throws {
        for c in try PresentationMatrixFile.load().verifyCases {
            let bytes = try XCTUnwrap(Data(base64Encoded: c.bytes), c.name)
            XCTAssertEqual(
                PresentationRules.iconMatches(bytes, sha256: c.sha256), c.expect, "verify: \(c.name)")
        }
    }

    // ── The edges the corpus does not carry ──────────────────────────────────────────────────

    /// A Swift String cannot hold a lone surrogate: JSONDecoder refuses the escape outright, so
    /// rule 2's surrogate clause holds by construction. The Worker never emits one (its member is
    /// client-core's `parsePresentation` output, which drops them).
    func testALoneSurrogateNeverReachesTheTextRule() {
        for json in [#"{"a":"x\udc00"}"#, #"{"a":"x\ud800y"}"#] {
            XCTAssertNil(try? JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)), json)
        }
    }

    func testNeverCarriesAnUnknownMember() {
        let got = PresentationRules.parsePresentation(
            core: .object([
                "presentation": .object([
                    "name": .string("P"), "extra": .int(1),
                    "icon": .object([
                        "sha256": .string(String(repeating: "a", count: 64)),
                        "contentType": .string("image/png"),
                        "original": .string("https://img.plrs.im/p/a/x"), "extra": .int(2),
                    ]),
                ])
            ]), docName: nil, product: "p")
        XCTAssertEqual(
            got?.jsonValue,
            .object([
                "name": .string("P"),
                "icon": .object([
                    "sha256": .string(String(repeating: "a", count: 64)),
                    "contentType": .string("image/png"),
                    "original": .string("https://img.plrs.im/p/a/x"), "sizes": .array([]),
                ]),
            ]))
    }

    func testAUsableURLsOriginIsItsSchemeAndAuthorityLowerCased() {
        XCTAssertEqual(
            PresentationRules.usableUrlOrigin("HTTPS://Img.Plrs.Im:443/x?y"), "https://img.plrs.im:443")
        XCTAssertEqual(PresentationRules.usableUrlOrigin("http://[::1]/x"), "http://[::1]")
        XCTAssertNil(PresentationRules.usableUrlOrigin("http://[::2]/x"))
        XCTAssertNil(PresentationRules.usableUrlOrigin(JSONValue.int(42)))
    }

    func testANonsensicalHeroSizeStillPicksSomething() {
        let icon = PresentationIcon(
            sha256: String(repeating: "a", count: 64), contentType: "image/png",
            original: "https://img.plrs.im/p/a/x", url: "https://img.plrs.im/p/a/x/{w}.webp",
            sizes: [PresentationIconSize(w: 64, sha256: String(repeating: "b", count: 64))])
        for (px, scale) in [(Double.nan, 2.0), (-5, 1), (.infinity, 1)] {
            guard
                case .size(let w, _, _) = PresentationRules.pickIconSize(
                    icon, px: px, scale: scale, decodable: ["image/webp"])
            else { return XCTFail("px \(px)") }
            XCTAssertEqual(w, 64)
        }
    }

    func testTheSafeLinkRule() {
        let original = "https://img.plrs.im/p/a/x"
        XCTAssertTrue(PresentationRules.safeFetchUrl("https://img.plrs.im/p/a/x/64.webp", original: original))
        XCTAssertFalse(PresentationRules.safeFetchUrl("https://evil.example/x", original: original))
        XCTAssertFalse(PresentationRules.safeFetchUrl("http://img.plrs.im/x", original: original))
        XCTAssertFalse(PresentationRules.safeFetchUrl("ftp://img.plrs.im/x", original: original))
        XCTAssertTrue(
            PresentationRules.safeFetchUrl("http://localhost:8787/a/1", original: "http://localhost:8787/a"))
        XCTAssertFalse(
            PresentationRules.safeFetchUrl("http://localhost:8788/a/1", original: "http://localhost:8787/a"))
    }

    func testDiscoveryCarriesTheMemberAndAMalformedOneNeverRefusesIt() throws {
        let doc = #"""
            {"product":"djdl","name":"DJDL","services":{},
             "core":{"presentation":{"name":"\u0007","accent":"#ABCDEF","icon":{"sha256":"nope"}}}}
            """#
        guard case .ok(let parsed) = Discovery.parse(Data(doc.utf8), expectedProduct: "djdl") else {
            return XCTFail("a malformed member must not refuse discovery")
        }
        XCTAssertEqual(parsed.presentation, Presentation(name: "DJDL", accent: "#abcdef"))
        guard
            case .ok(let none) = Discovery.parse(
                Data(#"{"product":"djdl","services":{}}"#.utf8), expectedProduct: "djdl")
        else { return XCTFail() }
        XCTAssertNil(none.presentation)
    }
}

// ── The source: fetch, verify, cache ────────────────────────────────────────────────────────

/// Answers icon fetches from a table and records them.
final class FakeIconFetcher: PresentationIconFetcher, @unchecked Sendable {
    private let lock = NSLock()
    private var table: [String: PresentationIconResponse]
    private var log: [URL] = []
    private let delayNanos: UInt64

    init(_ table: [String: PresentationIconResponse] = [:], delayNanos: UInt64 = 0) {
        self.table = table
        self.delayNanos = delayNanos
    }

    var requests: [URL] { lock.withLock { log } }

    func set(_ url: String, _ response: PresentationIconResponse?) {
        lock.withLock { table[url] = response }
    }

    func fetch(_ url: URL, timeoutSeconds: Double, maxBytes: Int) async -> PresentationIconResponse? {
        let response = lock.withLock { () -> PresentationIconResponse? in
            log.append(url)
            return table[url.absoluteString]
        }
        if delayNanos > 0 { try? await Task.sleep(nanoseconds: delayNanos) }
        return response
    }
}

func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func temporaryDirectory(_ tag: String) -> URL {
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("pkey-presentation-\(tag)-\(UUID().uuidString)", isDirectory: true)
    return url
}

/// A member with an original and three WebP widths whose bytes are `bytes(w)`.
struct PresentationFixture {
    static let original = Data("original-png".utf8)
    static func bytes(_ w: Int) -> Data { Data("webp-\(w)".utf8) }
    static let base = "https://img.plrs.im/djdl/a/\(sha256Hex(original))"

    static func member(widths: [Int] = [64, 128, 256], name: String = "DJDL") -> Presentation {
        Presentation(
            name: name, accent: "#2ed6e6",
            icon: PresentationIcon(
                sha256: sha256Hex(original), contentType: "image/png", width: 1024, height: 1024,
                original: base, url: "\(base)/{w}.webp",
                sizes: widths.map { PresentationIconSize(w: $0, sha256: sha256Hex(bytes($0))) }))
    }

    static func url(_ w: Int) -> String { "\(base)/\(w).webp" }

    static func fetcher(widths: [Int] = [64, 128, 256]) -> FakeIconFetcher {
        var table: [String: PresentationIconResponse] = [
            base: PresentationIconResponse(status: 200, body: original)
        ]
        for w in widths { table[url(w)] = PresentationIconResponse(status: 200, body: bytes(w)) }
        return FakeIconFetcher(table)
    }
}

final class PresentationSourceTests: XCTestCase {
    private var dirs: [URL] = []

    override func tearDown() {
        for d in dirs { try? FileManager.default.removeItem(at: d) }
        dirs = []
        super.tearDown()
    }

    private func source(
        _ fetcher: (any PresentationIconFetcher)?, dir: URL? = nil, product: String = "djdl",
        decodable: Set<String> = ["image/png", "image/webp"]
    ) -> ProductPresentationSource {
        let directory = dir ?? temporaryDirectory("src")
        dirs.append(directory)
        return ProductPresentationSource(
            product: product, directory: directory, fetcher: fetcher, decodable: decodable)
    }

    func testFetchesVerifiesAndCachesByHash() async {
        let fetcher = PresentationFixture.fetcher()
        let s = source(fetcher)
        s.accept(PresentationFixture.member())
        let got = await s.icon(px: 32, scale: 2)
        XCTAssertEqual(got, PresentationFixture.bytes(64))
        XCTAssertEqual(fetcher.requests.map(\.absoluteString), [PresentationFixture.url(64)])
        XCTAssertEqual(s.cachedFiles(), [sha256Hex(PresentationFixture.bytes(64))])
        // Memoised: no second fetch.
        _ = await s.icon(px: 32, scale: 2)
        XCTAssertEqual(fetcher.requests.count, 1)

        // A cold start reads the disk (re-hashed), not the network.
        let cold = FakeIconFetcher()
        let again = source(cold, dir: s.directory)
        again.loadCached()
        XCTAssertEqual(again.current(), PresentationFixture.member())
        let cached = await again.icon(px: 32, scale: 2)
        XCTAssertEqual(cached, PresentationFixture.bytes(64))
        XCTAssertTrue(cold.requests.isEmpty)
    }

    func testAMismatchedHashIsNeitherShownNorCached() async {
        let fetcher = PresentationFixture.fetcher()
        fetcher.set(PresentationFixture.url(64), PresentationIconResponse(status: 200, body: Data("evil".utf8)))
        let s = source(fetcher)
        s.accept(PresentationFixture.member())
        let got = await s.icon(px: 32, scale: 2)
        XCTAssertNil(got)
        XCTAssertTrue(s.cachedFiles().isEmpty)
    }

    func testOnly200Counts() async {
        for status in [204, 206, 301, 302, 304, 307, 308, 404, 500] {
            let fetcher = PresentationFixture.fetcher()
            fetcher.set(
                PresentationFixture.url(64),
                PresentationIconResponse(status: status, body: PresentationFixture.bytes(64)))
            let s = source(fetcher)
            s.accept(PresentationFixture.member())
            let got = await s.icon(px: 32, scale: 2)
            XCTAssertNil(got, "status \(status)")
            XCTAssertTrue(s.cachedFiles().isEmpty, "status \(status)")
        }
    }

    func testATamperedCacheFileIsDeletedAndFetchedAgain() async throws {
        let fetcher = PresentationFixture.fetcher()
        let s = source(fetcher)
        s.accept(PresentationFixture.member())
        let sha = sha256Hex(PresentationFixture.bytes(64))
        try FileManager.default.createDirectory(at: s.directory, withIntermediateDirectories: true)
        try Data("tampered".utf8).write(to: s.directory.appendingPathComponent(sha))
        let got = await s.icon(px: 32, scale: 2)
        XCTAssertEqual(got, PresentationFixture.bytes(64))
        XCTAssertEqual(fetcher.requests.count, 1)
        XCTAssertEqual(try Data(contentsOf: s.directory.appendingPathComponent(sha)), PresentationFixture.bytes(64))
    }

    func testPrunesToTheNamedFilesThenToTheCap() async throws {
        let widths = [64, 128, 256, 512, 1024]
        let fetcher = PresentationFixture.fetcher(widths: widths)
        let s = source(fetcher)
        let member = PresentationFixture.member(widths: widths)
        s.accept(member)
        try FileManager.default.createDirectory(at: s.directory, withIntermediateDirectories: true)
        try Data("stale".utf8).write(to: s.directory.appendingPathComponent(String(repeating: "c", count: 64)))
        // Every named file, oldest first: the original, then each width.
        for (i, sha) in ([member.icon!.sha256] + member.icon!.sizes.map(\.sha256)).enumerated() {
            let url = s.directory.appendingPathComponent(sha)
            try Data(sha.utf8).write(to: url)
            try FileManager.default.setAttributes(
                [.modificationDate: Date(timeIntervalSince1970: TimeInterval(1_000_000 + i))],
                ofItemAtPath: url.path)
        }
        s.accept(member)
        let left = Set(s.cachedFiles())
        XCTAssertEqual(left.count, PRESENTATION_CACHE_MAX_FILES)
        XCTAssertFalse(left.contains(member.icon!.sha256), "the oldest went first")
        XCTAssertFalse(left.contains(String(repeating: "c", count: 64)), "a file no member names is gone")
        XCTAssertTrue(FileManager.default.fileExists(atPath: s.directory.appendingPathComponent("presentation.json").path))

        // No member: every icon file and presentation.json go.
        s.accept(nil)
        XCTAssertTrue(s.cachedFiles().isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: s.directory.appendingPathComponent("presentation.json").path))
    }

    func testAFreshWriteIsKeptAndTheCapHolds() async throws {
        let widths = [64, 128, 256, 512, 1024]
        let fetcher = PresentationFixture.fetcher(widths: widths)
        let s = source(fetcher)
        s.accept(PresentationFixture.member(widths: widths))
        for (px, i) in [(64, 0), (128, 1), (256, 2), (512, 3), (1024, 4)] {
            _ = await s.icon(px: Double(px), scale: 1)
            XCTAssertLessThanOrEqual(s.cachedFiles().count, PRESENTATION_CACHE_MAX_FILES, "after \(i)")
        }
        XCTAssertTrue(s.cachedFiles().contains(sha256Hex(PresentationFixture.bytes(1024))))
    }

    func testPresentationJsonReadsBackOnlyWhenItIsTheParsersNormalForm() throws {
        let s = source(nil)
        s.accept(PresentationFixture.member())
        let file = s.directory.appendingPathComponent("presentation.json")
        let written = try XCTUnwrap(try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: file)).objectValue)
        XCTAssertEqual(written["v"], .int(1))
        XCTAssertEqual(written["product"], .string("djdl"))

        let cold = source(nil, dir: s.directory)
        cold.loadCached()
        XCTAssertEqual(cold.current(), PresentationFixture.member())

        // Tampered: an accent that is not lower case, a member the parser would never emit.
        var tampered = written
        var member = written["presentation"]!.objectValue!
        member["accent"] = .string("#2ED6E6")
        tampered["presentation"] = .object(member)
        try JSONEncoder().encode(JSONValue.object(tampered)).write(to: file)
        let rejected = source(nil, dir: s.directory)
        rejected.loadCached()
        XCTAssertNil(rejected.current())
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path), "a tampered file is deleted")

        // Another product's file.
        s.accept(PresentationFixture.member())
        let other = source(nil, dir: s.directory, product: "other")
        other.loadCached()
        XCTAssertNil(other.current())
    }

    func testADiscoveryThisSessionWinsOverTheFile() {
        let s = source(nil)
        s.accept(PresentationFixture.member(name: "Old"))
        let fresh = source(nil, dir: s.directory)
        fresh.accept(PresentationFixture.member(name: "New"))
        fresh.loadCached()
        XCTAssertEqual(fresh.current()?.name, "New")
    }

    func testSubscribersHearEachChangeOnce() {
        let s = source(nil)
        let heard = LockedValue<[String?]>([])
        let off = s.subscribe { p in heard.with { $0.append(p?.name) } }
        s.accept(PresentationFixture.member())
        s.accept(PresentationFixture.member())
        s.accept(nil)
        off()
        s.accept(PresentationFixture.member(name: "After"))
        XCTAssertEqual(heard.current, ["DJDL", nil])
    }

    func testAnUnsafeLinkOrALocalOnlyClientNeverFetches() async {
        // An icon built directly (the parser never yields one) on plain http to a public host.
        let unsafe = Presentation(
            name: "P",
            icon: PresentationIcon(
                sha256: sha256Hex(PresentationFixture.original), contentType: "image/png",
                original: "http://img.plrs.im/p/a/x"))
        let fetcher = FakeIconFetcher()
        let s = source(fetcher)
        s.accept(unsafe)
        let none = await s.icon(px: 32, scale: 1)
        XCTAssertNil(none)
        XCTAssertTrue(fetcher.requests.isEmpty)

        let local = source(nil)
        local.accept(PresentationFixture.member())
        let alsoNone = await local.icon(px: 32, scale: 1)
        XCTAssertNil(alsoNone)
    }

    func testNothingDecodableIsNoIcon() async {
        let fetcher = PresentationFixture.fetcher()
        let s = source(fetcher, decodable: ["image/avif"])
        s.accept(PresentationFixture.member())
        let none = await s.icon(px: 32, scale: 1)
        XCTAssertNil(none)
        XCTAssertTrue(fetcher.requests.isEmpty)
    }

    func testConcurrentCallsShareOneFetch() async {
        let fetcher = PresentationFixture.fetcher()
        let slow = FakeIconFetcher(
            [PresentationFixture.url(64): PresentationIconResponse(status: 200, body: PresentationFixture.bytes(64))],
            delayNanos: 100_000_000)
        _ = fetcher
        let s = source(slow)
        s.accept(PresentationFixture.member())
        async let a = s.icon(px: 32, scale: 2)
        async let b = s.icon(px: 64, scale: 1)
        let (x, y) = await (a, b)
        XCTAssertEqual(x, PresentationFixture.bytes(64))
        XCTAssertEqual(y, PresentationFixture.bytes(64))
        XCTAssertEqual(slow.requests.count, 1)
    }

    func testTheDefaultDecodableSetIsImageIOs() {
        let types = ProductPresentationSource.defaultDecodable
        XCTAssertTrue(types.isSubset(of: Set(PRESENTATION_ICON_TYPES)))
        XCTAssertTrue(types.contains("image/png"))
        XCTAssertTrue(types.contains("image/jpeg"))
        XCTAssertTrue(types.contains("image/webp"), "ImageIO decodes WebP on every supported OS")
    }
}

// ── The URLSession fetcher ──────────────────────────────────────────────────────────────────

/// A URLProtocol that answers from `IconStub.handler` and records each request it sees.
final class IconStubProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        IconStub.seen.with { $0.append(request) }
        guard let reply = IconStub.handler.current?(request) else { return }  // hangs: a timeout
        let response = HTTPURLResponse(
            url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1",
            headerFields: reply.headers)!
        if let location = reply.redirect {
            client?.urlProtocol(
                self, wasRedirectedTo: URLRequest(url: location), redirectResponse: response)
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

enum IconStub {
    struct Reply: Sendable {
        var status = 200
        var headers: [String: String] = [:]
        var body = Data()
        var redirect: URL?
    }

    static let handler = LockedValue<(@Sendable (URLRequest) -> Reply?)?>(nil)
    static let seen = LockedValue<[URLRequest]>([])

    static func fetcher() -> URLSessionIconFetcher {
        let configuration = URLSessionIconFetcher.makeConfiguration()
        configuration.protocolClasses = [IconStubProtocol.self]
        return URLSessionIconFetcher(configuration: configuration)
    }
}

final class URLSessionIconFetcherTests: XCTestCase {
    private let url = URL(string: "https://img.plrs.im/djdl/a/x/64.webp")!

    override func setUp() {
        super.setUp()
        IconStub.seen.set([])
    }

    override func tearDown() {
        IconStub.handler.set(nil)
        super.tearDown()
    }

    func testAPlainGetWithNoCredentialOrCookie() async throws {
        IconStub.handler.set { _ in IconStub.Reply(body: Data("ok".utf8)) }
        let got = await IconStub.fetcher().fetch(url, timeoutSeconds: 5, maxBytes: 1024)
        XCTAssertEqual(got, PresentationIconResponse(status: 200, body: Data("ok".utf8)))
        let request = try XCTUnwrap(IconStub.seen.current.first)
        XCTAssertEqual(request.httpMethod, "GET")
        for name in (request.allHTTPHeaderFields ?? [:]).keys {
            let lower = name.lowercased()
            XCTAssertFalse(lower == "authorization" || lower == "cookie" || lower.hasPrefix("x-pkey-"), name)
        }
    }

    func testARedirectIsNeverFollowed() async {
        IconStub.handler.set { request in
            request.url?.host == "img.plrs.im"
                ? IconStub.Reply(status: 302, headers: ["Location": "https://elsewhere.example/x"],
                    redirect: URL(string: "https://elsewhere.example/x"))
                : IconStub.Reply(body: Data("followed".utf8))
        }
        let got = await IconStub.fetcher().fetch(url, timeoutSeconds: 5, maxBytes: 1024)
        XCTAssertNotEqual(got?.status, 200)
        XCTAssertFalse(IconStub.seen.current.contains { $0.url?.host == "elsewhere.example" })
    }

    func testTheDelegateRefusesEveryRedirect() {
        let refuse = RefuseRedirects()
        let task = URLSession.shared.dataTask(with: url)
        let next = LockedValue<URLRequest??>(nil)
        refuse.urlSession(
            URLSession.shared, task: task,
            willPerformHTTPRedirection: HTTPURLResponse(
                url: url, statusCode: 301, httpVersion: nil, headerFields: nil)!,
            newRequest: URLRequest(url: url)
        ) { r in next.set(.some(r)) }
        XCTAssertEqual(next.current, .some(nil))
        XCTAssertTrue(refuse.redirected.current)
    }

    func testABodyPastTheCapIsRefused() async {
        IconStub.handler.set { _ in IconStub.Reply(body: Data(repeating: 7, count: 2048)) }
        let over = await IconStub.fetcher().fetch(url, timeoutSeconds: 5, maxBytes: 1024)
        XCTAssertNil(over)
        IconStub.handler.set { _ in
            IconStub.Reply(headers: ["Content-Length": "4096"], body: Data(repeating: 7, count: 16))
        }
        let declared = await IconStub.fetcher().fetch(url, timeoutSeconds: 5, maxBytes: 1024)
        XCTAssertNil(declared, "a declared length past the cap is refused before the body")
    }

    func testTheDeadlineCoversTheWholeExchange() async {
        IconStub.handler.set { _ in nil }  // never answers
        let start = Date()
        let got = await IconStub.fetcher().fetch(url, timeoutSeconds: 0.3, maxBytes: 1024)
        XCTAssertNil(got)
        XCTAssertLessThan(Date().timeIntervalSince(start), 5)
    }

    func testTheClientsFetcherUsesTheGeneratedLimits() {
        XCTAssertEqual(PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS, 10)
        XCTAssertEqual(PRESENTATION_ICON_MAX_BYTES, 10 * 1024 * 1024)
    }
}

// ── The client's accessor ───────────────────────────────────────────────────────────────────

final class ClientPresentationTests: XCTestCase {
    private let path = "/djdl/.well-known/polaris.json"

    private func discovery(_ member: Presentation?) -> String {
        var core: [String: JSONValue] = ["registration": .string("requires-license")]
        if let member { core["presentation"] = member.jsonValue }
        let doc: JSONValue = .object([
            "product": .string("djdl"), "name": .string("djdl"), "core": .object(core),
            "services": .object(["license": .object(["enabled": .bool(true)])]),
        ])
        return String(decoding: try! JSONEncoder().encode(doc), as: UTF8.self)
    }

    private func client(
        _ server: StubServer, dataDir: URL, fetcher: FakeIconFetcher, local: Bool = false
    ) async throws -> PolarisKeyClient {
        let core = CoreOptions(
            productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0", pinnedKeys: [:],
            store: InMemoryStore(deviceId: "dev"),
            transport: local ? NoNetworkTransport() : server.transport,
            dataDir: dataDir, presentationIconFetcher: fetcher)
        return try await PolarisKeyClient.create(options: PolarisKeyClientOptions(core: core))
    }

    func testDiscoveryFillsTheAccessorAndAFailedOneKeepsTheLast() async throws {
        let dataDir = temporaryDirectory("client")
        defer { try? FileManager.default.removeItem(at: dataDir) }
        let server = StubServer()
        let fetcher = PresentationFixture.fetcher()
        let c = try await client(server, dataDir: dataDir, fetcher: fetcher)
        XCTAssertNil(c.presentation)
        await server.reply(path, body: discovery(PresentationFixture.member()))
        await c.discover()
        XCTAssertEqual(c.presentation, PresentationFixture.member())
        XCTAssertEqual(c.presentationSource.current(), PresentationFixture.member())
        let icon = await c.presentationIcon(points: 32, scale: 2)
        XCTAssertEqual(icon, PresentationFixture.bytes(64))

        await server.reply(path, status: 503, body: "{}")
        await c.discover()
        XCTAssertEqual(c.presentation, PresentationFixture.member(), "a failed discovery keeps the last")

        // A cold start reads presentation.json before any network.
        let cold = try await client(StubServer(), dataDir: dataDir, fetcher: FakeIconFetcher())
        XCTAssertEqual(cold.presentation, PresentationFixture.member())
        await cold.close()

        await server.reply(path, body: discovery(nil))
        await c.discover()
        XCTAssertNil(c.presentation, "a document without the member clears it")
        await c.close()
    }

    func testALocalOnlyClientNeverFetchesTheIcon() async throws {
        let dataDir = temporaryDirectory("local")
        defer { try? FileManager.default.removeItem(at: dataDir) }
        let seed = ProductPresentationSource(
            product: "djdl", directory: dataDir.appendingPathComponent("djdl/presentation"),
            fetcher: nil)
        seed.accept(PresentationFixture.member())
        let fetcher = PresentationFixture.fetcher()
        let c = try await client(StubServer(), dataDir: dataDir, fetcher: fetcher, local: true)
        XCTAssertEqual(c.presentation, PresentationFixture.member(), "the last member, from disk")
        let icon = await c.presentationIcon(points: 32, scale: 2)
        XCTAssertNil(icon)
        XCTAssertTrue(fetcher.requests.isEmpty)
        await c.close()
    }
}
