// @pkey-feature release.changelog release.download
//
// `PolarisKeyRelease` — the Release client (P1b-07, PARITY §5.5). The conversation is pinned by the
// release-changelog transcripts (TranscriptTests.swift); this file holds what a transcript cannot
// record: the D-21 refusal before any dial, the refusal codes in both error shapes, and the URL
// builders' remaining flags.

import Foundation
import PolarisKey
import PolarisKeyCore
import PolarisKeyRelease
import XCTest

final class ReleaseTests: XCTestCase {
    private func client(
        _ server: StubServer, services: [ServiceSlug] = [.license, .config, .release],
        token: String? = nil
    ) async throws -> PolarisKeyClient {
        let store = InMemoryStore(deviceId: "dev")
        if let token { await store.setToken(token) }
        return try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], trustRefresh: false, store: store, transport: server.transport,
                expectedServices: services))
    }

    func testADisabledReleaseIsServiceUnavailableBeforeAnyDial() async throws {
        let server = StubServer()
        let c = try await client(server, services: [.license, .config])
        do {
            _ = try await c.release.changelog()
            XCTFail("changelog() did not refuse")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, PolarisError.serviceUnavailable)
        }
        do {
            _ = try await c.release.installURL()
            XCTFail("installURL() did not refuse")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, PolarisError.serviceUnavailable)
        }
        do {
            _ = try await c.release.downloadURL(version: "1.0.0", binary: "djdl", arch: "arm64")
            XCTFail("downloadURL() did not refuse")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, PolarisError.serviceUnavailable)
        }
        let calls = await server.requests(forPath: "/djdl/release/changelog")
        XCTAssertTrue(calls.isEmpty)
    }

    func testTheChangelogDecodesEntriesAndKeepsANullSummaryNil() async throws {
        let server = StubServer()
        await server.reply(
            "/djdl/release/changelog",
            body:
                #"{"entries":[{"version":"1.2.0","tag":"v1.2.0","date":"2023-11-10T00:00:00Z","summary":"Faster.","url":"u"},{"version":"1.1.0","tag":"v1.1.0","date":null,"summary":null,"url":"v"}]}"#
        )
        let c = try await client(server)
        let entries = try await c.release.changelog()
        XCTAssertEqual(
            entries,
            [
                ChangelogEntry(
                    version: "1.2.0", tag: "v1.2.0", date: "2023-11-10T00:00:00Z",
                    summary: "Faster.", url: "u"),
                ChangelogEntry(version: "1.1.0", tag: "v1.1.0", date: nil, summary: nil, url: "v"),
            ])
        let request = await server.requests(forPath: "/djdl/release/changelog").last
        XCTAssertNil(request?.headers["authorization"], "no token held, no bearer")
    }

    func testABodyWithNoEntriesIsEmpty() async throws {
        let server = StubServer()
        await server.reply("/djdl/release/changelog", body: "{}")
        let c = try await client(server)
        let entries = try await c.release.changelog()
        XCTAssertEqual(entries, [])
    }

    func testTheBearerIsForwardedWhenHeld() async throws {
        let server = StubServer()
        await server.reply("/djdl/release/changelog", body: #"{"entries":[]}"#)
        let c = try await client(server, token: "pkeyt_entitled")
        _ = try await c.release.changelog()
        let request = await server.requests(forPath: "/djdl/release/changelog").last
        XCTAssertEqual(request?.headers["authorization"], "Bearer pkeyt_entitled")
    }

    func testRefusalsSurfaceTheBodyCode() async throws {
        let cases: [(Int, String, String)] = [
            (401, #"{"error":{"code":"unauthorized"}}"#, "unauthorized"),
            (401, #"{"error":"download_auth_required"}"#, "download_auth_required"),
            (401, "{}", "unauthorized"),
            (403, #"{"error":{"code":"channel_not_allowed"}}"#, "channel_not_allowed"),
            (403, "not json", "forbidden"),
            (500, "{}", "not_found"),
        ]
        for (status, body, code) in cases {
            let server = StubServer()
            await server.reply("/djdl/release/changelog", status: status, body: body)
            let c = try await client(server)
            do {
                _ = try await c.release.changelog()
                XCTFail("\(status) did not throw")
            } catch let e as PolarisError {
                XCTAssertEqual(e.code, code, "\(status) \(body)")
            }
        }
    }

    func testTheURLBuildersMakeNoRequest() async throws {
        let server = StubServer()
        let c = try await client(server)
        let install = try await c.release.installURL()
        XCTAssertEqual(install.absoluteString, "https://key.example/djdl/release/install.sh")
        let plain = try await c.release.downloadURL(version: "1.3.0", binary: "djdl", arch: "arm64")
        XCTAssertEqual(plain.absoluteString, "https://key.example/djdl/release/dl/1.3.0/djdl-arm64")
        let dmg = try await c.release.downloadURL(
            version: "1.3.0", binary: "djdl", arch: "arm64", dmg: true)
        XCTAssertEqual(dmg.absoluteString, "https://key.example/djdl/release/dl/1.3.0/djdl-arm64.dmg")
        let sum = try await c.release.downloadURL(
            version: "1.3.0", binary: "djdl", arch: "x86_64", checksum: true)
        XCTAssertEqual(
            sum.absoluteString, "https://key.example/djdl/release/dl/1.3.0/djdl-x86_64?checksum=sha256")
        let all = await server.requests(forPath: "/djdl/release/install.sh")
        XCTAssertTrue(all.isEmpty)
    }
}
