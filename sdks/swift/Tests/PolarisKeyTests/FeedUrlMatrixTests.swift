// @pkey-feature update.feeds
//
// The Swift runner for `conformance/corpus/v2/feed-url-matrix.json` (plans/SP-00.md D5), read
// from the generator-owned mirror in `Resources/v2/`: every row's endpoint set and input go
// through `updateFeedURL` (what `client.update.feedUrl` expands), and the answer is the row's URL
// or its typed N/A (`product`). The kinds table equals `UpdateFeedKind`.

import Foundation
import PolarisKeyCore
import PolarisKeyUpdate
import XCTest

private let feedUrlMatrixFile = "feed-url-matrix.json"

private struct FeedUrlMatrix: Decodable {
    struct Input: Decodable {
        let kind: String
        let channel: String?
        let velopackChannel: String?
        let buildId: String?
    }
    struct Expect: Decodable {
        let url: String?
        let unsupported: String?
    }
    struct Row: Decodable {
        let name: String
        let endpoints: String
        let input: Input
        let expect: Expect
    }
    let feedUrlMatrixVersion: Int
    let kinds: [String: String]
    let endpointSets: [String: [String: String]]
    let rows: [Row]
}

final class FeedUrlMatrixTests: XCTestCase {
    private func matrix() throws -> FeedUrlMatrix {
        try CorpusBundleLoader.load(
            FeedUrlMatrix.self, (feedUrlMatrixFile as NSString).deletingPathExtension)
    }

    func testTheKindsAreUpdateFeedKind() throws {
        let m = try matrix()
        XCTAssertEqual(m.feedUrlMatrixVersion, 1)
        XCTAssertEqual(Set(m.kinds.keys), Set(UpdateFeedKind.allCases.map(\.rawValue)))
    }

    func testEveryRow() throws {
        let m = try matrix()
        XCTAssertFalse(m.rows.isEmpty)
        for row in m.rows {
            let endpoints = try XCTUnwrap(m.endpointSets[row.endpoints], row.name)
            let kind = try XCTUnwrap(UpdateFeedKind(rawValue: row.input.kind), row.name)
            let answer = updateFeedURL(
                kind, endpoints: endpoints, baseUrl: "https://key.plrs.im",
                channel: row.input.channel, velopackChannel: row.input.velopackChannel,
                buildId: row.input.buildId)
            switch answer {
            case .url(let url):
                XCTAssertNil(row.expect.unsupported, "\(row.name): expected unsupported, got \(url)")
                XCTAssertEqual(url.absoluteString, row.expect.url, row.name)
            case .unsupported(let u):
                XCTAssertEqual(u.reason, row.expect.unsupported, "\(row.name): \(u.detail)")
                XCTAssertEqual(u.feature, Feature.updateFeeds, row.name)
            }
        }
    }
}
