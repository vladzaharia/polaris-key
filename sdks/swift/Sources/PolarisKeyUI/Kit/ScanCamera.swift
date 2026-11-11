// @pkey-feature connect.local
// The camera behind Scan a code on iOS and iPadOS (CC-29K.3): AVFoundation, no dependency. The app
// declares `NSCameraUsageDescription` itself (the docs say so); the kit shows its own pre-prompt
// before the system's. `AVScanSource` is a `KitScanSource`; `ScanViewfinder` draws its preview with
// the viewfinder's corners. Everywhere else (a Mac, a simulator, a preview) the viewfinder is a dark
// panel: the camera never starts, and `AVScanSource.status` is `unavailable` with no camera.

import PolarisKeyUICore
import SwiftUI

#if os(iOS) && canImport(AVFoundation)
    import AVFoundation

    /// Reads QR codes with `AVCaptureMetadataOutput` (`.qr` only).
    @MainActor
    public final class AVScanSource: KitScanSource {
        public let session = AVCaptureSession()
        /// The session is started and stopped on the capture queue only.
        private let runner = SessionRunner()
        private let queue = DispatchQueue(label: "im.plrs.key.scan")
        private let reader = QRReader()
        private var configured = false

        public init() {}

        public var status: KitCameraStatus {
            guard AVCaptureDevice.default(for: .video) != nil else { return .unavailable }
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized: return .authorized
            case .notDetermined: return .notDetermined
            default: return .denied
            }
        }

        public func requestAccess() async -> Bool {
            await AVCaptureDevice.requestAccess(for: .video)
        }

        public func codes() -> AsyncStream<String> {
            AsyncStream { continuation in
                let runner = self.runner
                let session = self.session
                let reader = self.reader
                reader.continuation = continuation
                if !configured { configure() }
                runner.set(session)
                let queue = self.queue
                queue.async { runner.start() }
                continuation.onTermination = { _ in queue.async { runner.stop() } }
            }
        }

        private func configure() {
            configured = true
            guard let device = AVCaptureDevice.default(for: .video),
                let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input)
            else { return }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(reader, queue: queue)
            if output.availableMetadataObjectTypes.contains(.qr) { output.metadataObjectTypes = [.qr] }
        }
    }

    private final class SessionRunner: @unchecked Sendable {
        private var session: AVCaptureSession?
        func set(_ s: AVCaptureSession) { session = s }
        func start() { if let s = session, !s.isRunning { s.startRunning() } }
        func stop() { if let s = session, s.isRunning { s.stopRunning() } }
    }

    private final class QRReader: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
        var continuation: AsyncStream<String>.Continuation?
        func metadataOutput(
            _ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject],
            from connection: AVCaptureConnection
        ) {
            for case let code as AVMetadataMachineReadableCodeObject in objects {
                if let text = code.stringValue, !text.isEmpty { continuation?.yield(text) }
            }
        }
    }

    private struct CameraPreview: UIViewRepresentable {
        let session: AVCaptureSession
        func makeUIView(context: Context) -> PreviewView {
            let view = PreviewView()
            view.previewLayer.session = session
            view.previewLayer.videoGravity = .resizeAspectFill
            return view
        }
        func updateUIView(_ view: PreviewView, context: Context) {}
    }

    private final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer {
            // The layer class is fixed above, so the cast always holds.
            layer as? AVCaptureVideoPreviewLayer ?? AVCaptureVideoPreviewLayer()
        }
    }
#endif

/// The camera view with the viewfinder's corners: dark in both schemes, named for VoiceOver. It
/// pairs as soon as a code reads, so there is no shutter.
struct ScanViewfinder: View {
    let source: KitScanSource?
    let label: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var settled = false

    var body: some View {
        ZStack {
            Color.black
            #if os(iOS) && canImport(AVFoundation)
                if let av = source as? AVScanSource { CameraPreview(session: av.session) }
            #endif
            Corners()
                .stroke(Color.white.opacity(0.9), style: StrokeStyle(lineWidth: 4, lineCap: .round))
                .padding(28)
                .scaleEffect(settled || reduceMotion ? 1 : 1.06)
                .accessibilityHidden(true)
        }
        .aspectRatio(1, contentMode: .fit)
        .frame(maxWidth: 360)
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .onAppear {
            if reduceMotion { settled = true } else { withAnimation(.easeOut(duration: 0.4)) { settled = true } }
        }
    }

    private struct Corners: Shape {
        func path(in rect: CGRect) -> Path {
            var p = Path()
            let l: CGFloat = 36
            for (x, y, dx, dy) in [
                (rect.minX, rect.minY, 1.0, 1.0), (rect.maxX, rect.minY, -1.0, 1.0),
                (rect.minX, rect.maxY, 1.0, -1.0), (rect.maxX, rect.maxY, -1.0, -1.0),
            ] {
                p.move(to: CGPoint(x: x + dx * l, y: y))
                p.addLine(to: CGPoint(x: x, y: y))
                p.addLine(to: CGPoint(x: x, y: y + dy * l))
            }
            return p
        }
    }
}
