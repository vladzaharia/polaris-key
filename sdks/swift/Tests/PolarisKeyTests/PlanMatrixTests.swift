// @pkey-feature packs.plan packs.delta.feed
//
// `plan-matrix.json` (planMatrixVersion 2, plans/P4-01.md §4.5, plans/P4-10.md §4.4) through
// PolarisKeyPacks:
//
//   rows          the planner                → plan
//   variantCases  variant selection          → selectVariant
//   targetCases   a variant onto the planner → planTarget
//   feedDeltaCases the feed's delta menu merged (plans/P4-29.md §4.3) → withFeedDeltas, then
//                 planTarget and plan
//
// Read from the checkout through `CorpusLocator`.

import Foundation
import PolarisKeyCore
import PolarisKeyPacks
import XCTest

final class PlanMatrixTests: XCTestCase {
    private func matrix() throws -> [String: JSONValue] {
        try XCTUnwrap(CorpusLocator.load(JSONValue.self, "plan-matrix").objectValue)
    }

    func testHasEveryRowAndCase() throws {
        let m = try matrix()
        XCTAssertEqual(m["planMatrixVersion"], .int(2))
        XCTAssertEqual(m["requestWeight"], .int(16384))
        XCTAssertEqual(m["requestWeight"]?.intValue, PLAN_REQUEST_WEIGHT)
        XCTAssertEqual(m["rows"]?.arrayValue?.count, 28)
        XCTAssertEqual(m["variantCases"]?.arrayValue?.count, 11)
        XCTAssertEqual(m["targetCases"]?.arrayValue?.count, 22)
        XCTAssertEqual(m["feedDeltaCases"]?.arrayValue?.count, 13)
    }

    func testRows() throws {
        for row in try XCTUnwrap(matrix()["rows"]?.arrayValue) {
            let o = try XCTUnwrap(row.objectValue)
            let input = try XCTUnwrap(o["input"]?.objectValue)
            let target = try XCTUnwrap(PlanTarget(json: input["target"]!), "\(o["id"]!)")
            let installed = try (input["installed"]?.arrayValue ?? []).map { try XCTUnwrap(PlanInstalled(json: $0)) }
            let caps = try XCTUnwrap(PlanCaps(json: input["caps"]!))
            XCTAssertEqual(
                plan(target: target, installed: installed, caps: caps).json, normalisedJSON(o["expect"]!),
                "row \(o["id"]!): \(o["description"]!)")
        }
    }

    func testVariantCases() throws {
        for c in try XCTUnwrap(matrix()["variantCases"]?.arrayValue) {
            let o = try XCTUnwrap(c.objectValue)
            let p = try XCTUnwrap(o["prefs"]?.objectValue)
            var axes: [String: [String]] = [:]
            for (k, v) in p["axes"]?.objectValue ?? [:] { axes[k] = v.arrayValue?.compactMap(\.stringValue) ?? [] }
            let prefs = VariantPrefs(engine: p["engine"]?.stringValue, axes: axes)
            XCTAssertEqual(
                selectVariant(try XCTUnwrap(o["variants"]?.arrayValue), prefs).json, normalisedJSON(o["expect"]!),
                "variant \(o["id"]!): \(o["description"]!)")
        }
    }

    func testTargetCases() throws {
        for c in try XCTUnwrap(matrix()["targetCases"]?.arrayValue) {
            let o = try XCTUnwrap(c.objectValue)
            let variant = try XCTUnwrap(PackVariant(json: o["variant"]!), "\(o["id"]!)")
            let index: FilesIndexDoc? = o["filesIndex"] == .null ? nil : FilesIndexDoc(json: o["filesIndex"]!)
            // plans/P4-10.md §4.4: `chunkIndex` is absent (nil) on the cases before P4-10.
            var chunkIndex: PlanChunkIndex?
            if let ci = o["chunkIndex"], ci != .null {
                chunkIndex = try XCTUnwrap(PlanChunkIndex(json: ci), "\(o["id"]!)")
            }
            XCTAssertEqual(
                planTarget(
                    variant, recordSha256: try XCTUnwrap(o["recordSha256"]?.stringValue), filesIndex: index,
                    chunkIndex: chunkIndex
                ).json,
                normalisedJSON(o["expect"]!), "target \(o["id"]!): \(o["description"]!)")
        }
    }

    func testFeedDeltaCases() throws {
        for c in try XCTUnwrap(matrix()["feedDeltaCases"]?.arrayValue) {
            let o = try XCTUnwrap(c.objectValue)
            let id = "\(o["id"]!)"
            let variant = try XCTUnwrap(PackVariant(json: o["variant"]!), id)
            let index: FilesIndexDoc? = o["filesIndex"] == .null ? nil : FilesIndexDoc(json: o["filesIndex"]!)
            var chunkIndex: PlanChunkIndex?
            if let ci = o["chunkIndex"], ci != .null {
                chunkIndex = try XCTUnwrap(PlanChunkIndex(json: ci), id)
            }
            let merged = withFeedDeltas(variant, rawFeedDeltas(o["deltas"]))
            let target = planTarget(
                merged.variant, recordSha256: try XCTUnwrap(o["recordSha256"]?.stringValue), filesIndex: index,
                chunkIndex: chunkIndex)
            let installed = try (o["installed"]?.arrayValue ?? []).map { try XCTUnwrap(PlanInstalled(json: $0), id) }
            let caps = try XCTUnwrap(PlanCaps(json: o["caps"]!), id)
            let got: JSONValue = .object([
                "feedIds": .array(merged.feedIds.map(JSONValue.string)),
                "target": target.json,
                "plan": plan(target: target, installed: installed, caps: caps).json,
            ])
            XCTAssertEqual(got, normalisedJSON(o["expect"]!), "feed delta \(id): \(o["description"]!)")
        }
    }
}
