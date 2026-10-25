// A QR code for the kit's offline-activation screens (and a host's own), drawn by CoreImage.

import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI

/// A QR code for `text`, drawn by CoreImage's generator (no dependency), crisp at any size.
public struct PolarisQRCode: View {
    public let text: String
    public var accessibilityLabel: String

    public init(_ text: String, accessibilityLabel: String = "QR code") {
        self.text = text
        self.accessibilityLabel = accessibilityLabel
    }

    public var body: some View {
        if let image = PolarisQRCode.cgImage(for: text) {
            Image(decorative: image, scale: 1)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 12).fill(Color.white))
                .accessibilityElement()
                .accessibilityLabel(accessibilityLabel)
                .accessibilityAddTraits(.isImage)
        }
    }

    /// The QR code's modules as a `CGImage`, scaled up by an integer factor so the bitmap is large
    /// enough to stay crisp whatever interpolation the drawn size applies, or nil when `text`
    /// cannot be encoded. Medium error correction.
    public static func cgImage(for text: String) -> CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        // The generator emits one pixel per module; scale so the smallest TV/pane draw (about 200
        // pt at 3x) is covered without resampling blur.
        let modules = max(output.extent.width, 1)
        let scale = max(1, (720 / modules).rounded(.up))
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        return CIContext(options: [.useSoftwareRenderer: true])
            .createCGImage(scaled, from: scaled.extent)
    }
}

/// How the offline screens draw a request code (kept from the retired SP-S04 surface).
enum PolarisOfflineSurface {
    /// The request code: the device id alone. The card shows it, Copy copies it and the QR encodes
    /// it, all from this one value.
    static func requestCode(deviceId: String) -> String { deviceId }

    /// The code as DRAWN: the raw id with invisible break points after every 4 characters (a short
    /// tail joins the group before it, so no line ends in an orphan) and word joiners around real
    /// hyphens. The text never relies on the system's hyphenation, which draws hyphens that are not
    /// in the code. Copy and the QR carry the raw id; stripping U+200B and U+2060 gives it back.
    static func displayCode(_ id: String) -> String {
        let chars = Array(id)
        var out = ""
        for (i, ch) in chars.enumerated() {
            if ch == "-" {
                out.append("\u{2060}-\u{2060}")
            } else {
                out.append(ch)
            }
            let done = i + 1
            let remaining = chars.count - done
            if done % 4 == 0 && remaining > 2 { out.append("\u{200B}") }
        }
        return out
    }

}
