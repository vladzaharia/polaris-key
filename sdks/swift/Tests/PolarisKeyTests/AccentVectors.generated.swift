// GENERATED FILE — do not edit by hand.
//
// Written by `pnpm --filter @polaris-key/brand gen` (packages/brand/scripts/gen.ts) from
// packages/brand/src/tokens/ and the launch kit copy in packages/brand/kit/.
// `pnpm gen brand --check` fails the green gate on any difference. To change a value, edit
// its source and regenerate.
//
// The accent resolver's shared vectors (packages/brand/fixtures/accent-vectors.json) as Swift
// literals for AccentResolverTests.

struct DeriveVector {
    let name: String
    let pixels: [[Int]]
    let expect: String?
}

struct ResolveVector {
    let name: String
    let input: String
    let dark: Bool
    let solid: String
    let on: String
    let fg: String
    let subtle: String
    let focus: String
}

struct DangerVector {
    let dark: Bool
    let input: String
    let solid: String
}

enum AccentVectors {
    static let derive: [DeriveVector] = [
        DeriveVector(name: "tidewater", pixels: [[11, 58, 72, 255, 2600], [95, 227, 207, 255, 700], [146, 198, 194, 255, 700], [245, 211, 138, 255, 150], [0, 0, 0, 0, 96]], expect: "#369186"),
        DeriveVector(name: "drift-kart", pixels: [[255, 90, 44, 255, 2900], [26, 11, 6, 255, 700], [255, 243, 232, 255, 300]], expect: "#e03d00"),
        DeriveVector(name: "greyscale", pixels: [[32, 32, 32, 255, 3000], [224, 224, 224, 255, 1000]], expect: nil),
        DeriveVector(name: "small-accent", pixels: [[48, 48, 52, 255, 3800], [224, 32, 32, 255, 300]], expect: nil),
        DeriveVector(name: "translucent-ignored", pixels: [[122, 47, 255, 100, 3000], [46, 160, 79, 255, 1000]], expect: "#239848"),
        DeriveVector(name: "two-clusters", pixels: [[74, 90, 122, 255, 3600], [255, 212, 0, 255, 400]], expect: "#987e00"),
        DeriveVector(name: "empty", pixels: [[0, 0, 0, 0, 64]], expect: nil),
    ]

    static let resolve: [ResolveVector] = [
        ResolveVector(name: "tidewater", input: "#369186", dark: true, solid: "#26847a", on: "#ffffff", fg: "#72cabe", subtle: "#0a181e", focus: "#72cabe"),
        ResolveVector(name: "tidewater", input: "#369186", dark: false, solid: "#26847a", on: "#ffffff", fg: "#14796f", subtle: "#e1ecf2", focus: "#26847a"),
        ResolveVector(name: "core-violet-dark", input: "#9a5cff", dark: true, solid: "#9051f3", on: "#ffffff", fg: "#c0a6ff", subtle: "#17122d", focus: "#c0a6ff"),
        ResolveVector(name: "core-violet-dark", input: "#9a5cff", dark: false, solid: "#9051f3", on: "#ffffff", fg: "#7b36da", subtle: "#ece7fe", focus: "#9051f3"),
        ResolveVector(name: "core-violet-light", input: "#7a2fff", dark: true, solid: "#7a2fff", on: "#ffffff", fg: "#b7aaff", subtle: "#140e2e", focus: "#b7aaff"),
        ResolveVector(name: "core-violet-light", input: "#7a2fff", dark: false, solid: "#7a2fff", on: "#ffffff", fg: "#7321f6", subtle: "#eae4ff", focus: "#7a2fff"),
        ResolveVector(name: "drift-kart", input: "#ff6a3d", dark: true, solid: "#ff6a3d", on: "#060912", fg: "#ff987a", subtle: "#241517", focus: "#ff987a"),
        ResolveVector(name: "drift-kart", input: "#ff6a3d", dark: false, solid: "#ec592a", on: "#060912", fg: "#b73500", subtle: "#f5e8ea", focus: "#ec592a"),
        ResolveVector(name: "light-teal", input: "#5fe3cf", dark: true, solid: "#5fe3cf", on: "#060912", fg: "#5fe3cf", subtle: "#112329", focus: "#5fe3cf"),
        ResolveVector(name: "light-teal", input: "#5fe3cf", dark: false, solid: "#009a8a", on: "#060912", fg: "#007a6d", subtle: "#ddeff3", focus: "#009a8a"),
        ResolveVector(name: "yellow", input: "#ffd400", dark: true, solid: "#ffd400", on: "#060912", fg: "#ffd400", subtle: "#242110", focus: "#ffd400"),
        ResolveVector(name: "yellow", input: "#ffd400", dark: false, solid: "#a38700", on: "#060912", fg: "#7d6700", subtle: "#eeede6", focus: "#a38700"),
        ResolveVector(name: "blue", input: "#0050ff", dark: true, solid: "#0050ff", on: "#ffffff", fg: "#92b7ff", subtle: "#05122e", focus: "#92b7ff"),
        ResolveVector(name: "blue", input: "#0050ff", dark: false, solid: "#0050ff", on: "#ffffff", fg: "#004ffc", subtle: "#dde7ff", focus: "#0050ff"),
        ResolveVector(name: "pink", input: "#e91e63", dark: true, solid: "#e61860", on: "#ffffff", fg: "#ff92a5", subtle: "#210b1b", focus: "#ff92a5"),
        ResolveVector(name: "pink", input: "#e91e63", dark: false, solid: "#e61860", on: "#ffffff", fg: "#c2004e", subtle: "#f4e2ef", focus: "#e61860"),
        ResolveVector(name: "green", input: "#00a86b", dark: true, solid: "#00a86b", on: "#060912", fg: "#4fd494", subtle: "#051c1d", focus: "#4fd494"),
        ResolveVector(name: "green", input: "#00a86b", dark: false, solid: "#009d64", on: "#060912", fg: "#007c4e", subtle: "#ddeff0", focus: "#009d64"),
        ResolveVector(name: "navy", input: "#1b1f3b", dark: true, solid: "#5b6282", on: "#ffffff", fg: "#adb5da", subtle: "#10141f", focus: "#adb5da"),
        ResolveVector(name: "navy", input: "#1b1f3b", dark: false, solid: "#1b1f3b", on: "#ffffff", fg: "#1b1f3b", subtle: "#e0e2eb", focus: "#1b1f3b"),
        ResolveVector(name: "grey", input: "#808080", dark: true, solid: "#777676", on: "#ffffff", fg: "#b7b7b7", subtle: "#14161e", focus: "#b7b7b7"),
        ResolveVector(name: "grey", input: "#808080", dark: false, solid: "#777676", on: "#ffffff", fg: "#696969", subtle: "#e9ebf1", focus: "#777676"),
        ResolveVector(name: "black", input: "#000000", dark: true, solid: "#646464", on: "#ffffff", fg: "#b7b7b7", subtle: "#11141c", focus: "#b7b7b7"),
        ResolveVector(name: "black", input: "#000000", dark: false, solid: "#000000", on: "#ffffff", fg: "#000000", subtle: "#dddfe6", focus: "#000000"),
        ResolveVector(name: "white", input: "#ffffff", dark: true, solid: "#ffffff", on: "#060912", fg: "#ffffff", subtle: "#24272e", focus: "#ffffff"),
        ResolveVector(name: "white", input: "#ffffff", dark: false, solid: "#8a8989", on: "#060912", fg: "#696969", subtle: "#ebedf3", focus: "#8a8989"),
        ResolveVector(name: "short-hex", input: "#f60", dark: true, solid: "#ff6600", on: "#060912", fg: "#ff996d", subtle: "#241410", focus: "#ff996d"),
        ResolveVector(name: "short-hex", input: "#f60", dark: false, solid: "#e95d00", on: "#060912", fg: "#ad4300", subtle: "#f5e9e6", focus: "#e95d00"),
    ]

    static let danger: [DangerVector] = [
        DangerVector(dark: true, input: "#f2513f", solid: "#db3a2b"),
        DangerVector(dark: false, input: "#be2323", solid: "#be2323"),
    ]
}
