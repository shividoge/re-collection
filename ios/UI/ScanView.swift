import ARKit
import MetalKit
import SwiftUI

struct ScanView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        ZStack {
            if let accumulator = model.engine.accumulator {
                CameraMetalView(
                    session: model.engine.session,
                    accumulator: accumulator,
                    showsCameraFeed: model.showsCameraFeed,
                    onFPS: { fps in Task { @MainActor in model.previewFPS = fps } },
                    onFailure: { message in Task { @MainActor in model.fail(message) } })
                    .ignoresSafeArea()
            }

            VStack {
                HStack(spacing: 12) {
                    Text(Self.formatPoints(model.pointCount))
                        .monospacedDigit()
                    if let message = statusMessage {
                        Text(message)
                    }
                    Spacer()
                    Text("\(Int(model.previewFPS.rounded())) fps")
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                .font(.callout.weight(.medium))
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(.ultraThinMaterial, in: Capsule())

                Spacer()

                HStack(spacing: 16) {
                    Button(model.showsCameraFeed ? "Cloud only" : "Show camera") {
                        model.showsCameraFeed.toggle()
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.large)

                    Button("Stop") { model.stopScan() }
                        .buttonStyle(.borderedProminent)
                        .tint(.red)
                        .controlSize(.large)
                }
            }
            .padding()
        }
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
    }

    private var statusMessage: String? {
        model.roomCaptured ? "Room captured" : model.trackingMessage
    }

    private static func formatPoints(_ count: Int) -> String {
        if count >= 1_000_000 { return String(format: "%.1fM points", Double(count) / 1_000_000) }
        if count >= 1_000 { return "\(count / 1_000)k points" }
        return "\(count) points"
    }
}

/// Hosts the MTKView. The coordinator keeps the Renderer alive, since
/// MTKView only holds its delegate weakly.
struct CameraMetalView: UIViewRepresentable {
    let session: ARSession
    let accumulator: PointAccumulator
    let showsCameraFeed: Bool
    let onFPS: (Double) -> Void
    let onFailure: (String) -> Void

    final class Coordinator {
        var renderer: Renderer?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> MTKView {
        // Same device as the accumulator, so the renderer can draw its buffer directly.
        let view = MTKView(frame: .zero, device: accumulator.device)
        view.colorPixelFormat = .bgra8Unorm
        view.depthStencilPixelFormat = .depth32Float
        view.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
        view.clearDepth = 1
        view.preferredFramesPerSecond = 60
        view.framebufferOnly = true

        do {
            let renderer = try Renderer(view: view, session: session, accumulator: accumulator)
            renderer.onFPS = onFPS
            renderer.showsCameraFeed = showsCameraFeed
            context.coordinator.renderer = renderer
            view.delegate = renderer
        } catch {
            onFailure(error.localizedDescription)
        }
        return view
    }

    func updateUIView(_ view: MTKView, context: Context) {
        context.coordinator.renderer?.showsCameraFeed = showsCameraFeed
    }
}
