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

                controls
            }
            .padding()
        }
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
    }

    @ViewBuilder
    private var controls: some View {
        switch model.phase {
        case .savingRoom:
            HStack(spacing: 12) {
                ProgressView()
                Text("Saving room…")
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .background(.ultraThinMaterial, in: Capsule())

        case .roomSaved(let export):
            VStack(spacing: 12) {
                Text("Room saved: \(Self.formatPoints(export.pointCount)) at 1 cm")
                    .font(.callout.weight(.medium))
                HStack(spacing: 16) {
                    ShareLink(items: [export.plyURL, export.binURL]) {
                        Label("Share room files", systemImage: "square.and.arrow.up")
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)

                    Button("Done") { model.stopScan() }
                        .buttonStyle(.bordered)
                        .controlSize(.large)
                }
            }
            .padding()
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20))

        default:
            HStack(spacing: 12) {
                Button(model.showsCameraFeed ? "Cloud only" : "Show camera") {
                    model.showsCameraFeed.toggle()
                }
                .buttonStyle(.bordered)

                Button("Save room") { model.finishScan() }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.pointCount == 0)

                Button("Cancel", role: .destructive) { model.stopScan() }
                    .buttonStyle(.bordered)
            }
            .controlSize(.large)
        }
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
