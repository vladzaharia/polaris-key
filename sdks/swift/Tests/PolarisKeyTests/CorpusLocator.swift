// The checkout's conformance data, found from this source file through `#filePath` (P0-44).
//
// The Swift tests read `conformance/` in place, as the Node, Python and Kotlin runners do: the
// corpus in `conformance/corpus/v2/` (written by `pnpm gen corpus`), its `content/` directory and
// the HTTP transcripts in `conformance/transcripts/` (written by `pnpm gen transcripts`). Nothing
// is copied into the test bundle. `#filePath` is this file's absolute path at compile time, so
// `swift test` finds the files from any working directory (CI runs it from the repository root
// with `--package-path sdks/swift`), as long as the package sits in a monorepo checkout.

import Foundation

enum CorpusLocator {
    /// The repository root: this file is `sdks/swift/Tests/PolarisKeyTests/CorpusLocator.swift`.
    static let root: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        return url
    }()

    /// `conformance/corpus/v2/`.
    static var corpusDir: URL {
        root.appendingPathComponent("conformance/corpus/v2", isDirectory: true)
    }

    /// `conformance/corpus/v2/content/`, the content corpus.
    static var contentDir: URL { corpusDir.appendingPathComponent("content", isDirectory: true) }

    /// `conformance/transcripts/`, the HTTP transcripts.
    static var transcriptsDir: URL {
        root.appendingPathComponent("conformance/transcripts", isDirectory: true)
    }

    /// A file of the repository, by its path from the root.
    static func file(_ path: String) -> URL { root.appendingPathComponent(path) }

    /// `conformance/corpus/v2/<name>.json`, which must exist.
    static func url(_ name: String) throws -> URL {
        let url = corpusDir.appendingPathComponent("\(name).json")
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw NSError(
                domain: "corpus", code: 1,
                userInfo: [
                    NSLocalizedDescriptionKey:
                        "\(url.path) is missing: run `swift test` from a monorepo checkout"
                ])
        }
        return url
    }

    /// Decode `conformance/corpus/v2/<name>.json`.
    static func load<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(contentsOf: url(name)))
    }
}
