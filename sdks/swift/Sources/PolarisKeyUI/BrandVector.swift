// The Polaris Locker attribution artwork (the micro mark and the "Powered by" badge) as vector
// data: filled SVG paths in nested groups, drawn at any size. The data is generated from
// `packages/brand/locker-kit` (`pnpm gen brand` writes BrandMarks.generated.swift); the kit's
// badge is outlined type, so it needs no font and stays crisp at every scale.

import CoreGraphics
import SwiftUI

/// One node of a vector drawing: a group (translate, then scale, and an inherited fill) or a filled
/// path (SVG path data, absolute and relative lines and curves).
public indirect enum BrandVectorNode: Sendable {
    case group(tx: Double, ty: Double, sx: Double, sy: Double, fill: BrandColor?, children: [BrandVectorNode])
    case path(fill: BrandColor?, d: String)
}

/// A vector drawing with the SVG's own width and height (its viewBox is `0 0 width height`).
public struct BrandVector: Sendable {
    public let width: Double
    public let height: Double
    public let nodes: [BrandVectorNode]

    public init(width: Double, height: Double, nodes: [BrandVectorNode]) {
        self.width = width
        self.height = height
        self.nodes = nodes
    }

    /// Every filled path in drawing order, with its transform into the viewBox and its colour.
    func paths() -> [(path: CGPath, fill: BrandColor)] {
        var out: [(CGPath, BrandColor)] = []
        func walk(_ nodes: [BrandVectorNode], _ transform: CGAffineTransform, _ inherited: BrandColor?) {
            for node in nodes {
                switch node {
                case let .group(tx, ty, sx, sy, fill, children):
                    // SVG applies `translate` first, then `scale`: x' = tx + sx * x.
                    let t = CGAffineTransform(scaleX: sx, y: sy).concatenating(
                        CGAffineTransform(translationX: tx, y: ty)
                    ).concatenating(transform)
                    walk(children, t, fill ?? inherited)
                case let .path(fill, d):
                    guard let color = fill ?? inherited else { continue }
                    var t = transform
                    if let p = SVGPathData.parse(d).copy(using: &t) { out.append((p, color)) }
                }
            }
        }
        walk(nodes, .identity, nil)
        return out
    }
}

/// SVG path data → `CGPath`. Handles the commands the kit's artwork uses: M L H V Q C T S Z, in
/// absolute and relative form. Anything else ends the path (`SVGPathDataTests` parses every
/// shipped drawing and checks nothing is dropped).
enum SVGPathData {
    static func parse(_ d: String) -> CGPath {
        let path = CGMutablePath()
        var scanner = Scanner(d)
        var current = CGPoint.zero
        var start = CGPoint.zero
        var lastCubic: CGPoint?
        var lastQuad: CGPoint?
        var command: Character = "M"
        while let next = scanner.command(default: command) {
            command = next
            let rel = command.isLowercase
            let base = rel ? current : .zero
            func point() -> CGPoint? {
                guard let x = scanner.number(), let y = scanner.number() else { return nil }
                return CGPoint(x: base.x + x, y: base.y + y)
            }
            switch command.uppercased() {
            case "M":
                guard let p = point() else { return path }
                path.move(to: p)
                current = p
                start = p
                command = rel ? "l" : "L"
                lastCubic = nil
                lastQuad = nil
            case "L":
                guard let p = point() else { return path }
                path.addLine(to: p)
                current = p
                lastCubic = nil
                lastQuad = nil
            case "H":
                guard let x = scanner.number() else { return path }
                current = CGPoint(x: rel ? current.x + x : x, y: current.y)
                path.addLine(to: current)
                lastCubic = nil
                lastQuad = nil
            case "V":
                guard let y = scanner.number() else { return path }
                current = CGPoint(x: current.x, y: rel ? current.y + y : y)
                path.addLine(to: current)
                lastCubic = nil
                lastQuad = nil
            case "Q":
                guard let c = point(), let p = point() else { return path }
                path.addQuadCurve(to: p, control: c)
                current = p
                lastQuad = c
                lastCubic = nil
            case "T":
                guard let p = point() else { return path }
                let c = lastQuad.map { CGPoint(x: 2 * current.x - $0.x, y: 2 * current.y - $0.y) } ?? current
                path.addQuadCurve(to: p, control: c)
                current = p
                lastQuad = c
                lastCubic = nil
            case "C":
                guard let c1 = point(), let c2 = point(), let p = point() else { return path }
                path.addCurve(to: p, control1: c1, control2: c2)
                current = p
                lastCubic = c2
                lastQuad = nil
            case "S":
                guard let c2 = point(), let p = point() else { return path }
                let c1 = lastCubic.map { CGPoint(x: 2 * current.x - $0.x, y: 2 * current.y - $0.y) } ?? current
                path.addCurve(to: p, control1: c1, control2: c2)
                current = p
                lastCubic = c2
                lastQuad = nil
            case "Z":
                path.closeSubpath()
                current = start
                lastCubic = nil
                lastQuad = nil
            default:
                return path
            }
        }
        return path
    }

    /// The commands and numbers of one path string.
    struct Scanner {
        private let chars: [Character]
        private var i = 0
        init(_ s: String) { chars = Array(s) }

        private mutating func skipSeparators() {
            while i < chars.count, chars[i] == " " || chars[i] == "," || chars[i] == "\n" || chars[i] == "\t" {
                i += 1
            }
        }

        /// The next command letter, or `default` when numbers follow the previous command.
        mutating func command(default previous: Character) -> Character? {
            skipSeparators()
            guard i < chars.count else { return nil }
            if chars[i].isLetter {
                defer { i += 1 }
                return chars[i]
            }
            return previous.uppercased() == "Z" ? nil : previous
        }

        mutating func number() -> Double? {
            skipSeparators()
            let begin = i
            if i < chars.count, chars[i] == "-" || chars[i] == "+" { i += 1 }
            var seenDot = false
            while i < chars.count {
                let c = chars[i]
                if c.isNumber {
                    i += 1
                } else if c == ".", !seenDot {
                    seenDot = true
                    i += 1
                } else if c == "e" || c == "E" {
                    i += 1
                    if i < chars.count, chars[i] == "-" || chars[i] == "+" { i += 1 }
                } else {
                    break
                }
            }
            return begin == i ? nil : Double(String(chars[begin..<i]))
        }
    }
}

/// A `BrandVector` drawn to fill its frame (aspect-fit); decorative unless the caller labels it.
struct BrandVectorView: View {
    let vector: BrandVector

    var body: some View {
        Canvas { context, size in
            let scale = min(size.width / vector.width, size.height / vector.height)
            let dx = (size.width - vector.width * scale) / 2
            let dy = (size.height - vector.height * scale) / 2
            let t = CGAffineTransform(scaleX: scale, y: scale).concatenating(
                CGAffineTransform(translationX: dx, y: dy))
            for (cg, fill) in vector.paths() {
                var tt = t
                if let moved = cg.copy(using: &tt) {
                    context.fill(Path(moved), with: .color(fill.color))
                }
            }
        }
        .aspectRatio(vector.width / vector.height, contentMode: .fit)
    }
}
