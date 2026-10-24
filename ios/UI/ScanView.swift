import ARKit
import MetalKit
import SwiftUI

struct ScanView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        ZStack {
            CameraMetalView(
                session: model.engine.session,
                onFPS: { fps in Task { @MainActor in model.previewFPS = fps } },
                onFailure: { message in Task { @MainActor in model.fail(message) } })
                .ignoresSafeArea()

            VStack {
                HStack {
                    if let message = model.trackingMessage {
                        Text(message)
                    }
                    Spacer()
                    Text("\(Int(model.previewFPS.rounded())) fps")
                        .monospacedDigit()
                }
                .font(.callout.weight(.medium))
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(.ultraThinMaterial, in: Capsule())

                Spacer()

                Button("Stop") { model.stopScan() }
                    .buttonStyle(.borderedProminent)
                    .tint(.red)
                    .controlSize(.large)
            }
            .padding()
        }
    }
}

/// Hosts the MTKView. The coordinator keeps the Renderer alive, since
/// MTKView only holds its delegate weakly.
struct CameraMetalView: UIViewRepresentable {
    let session: ARSession
    let onFPS: (Double) -> Void
    let onFailure: (String) -> Void

    final class Coordinator {
        var renderer: Renderer?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> MTKView {
        let view = MTKView(frame: .zero, device: MTLCreateSystemDefaultDevice())
        view.colorPixelFormat = .bgra8Unorm
        view.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
        view.preferredFramesPerSecond = 60
        view.framebufferOnly = true

        do {
            let renderer = try Renderer(view: view, session: session)
            renderer.onFPS = onFPS
            context.coordinator.renderer = renderer
            view.delegate = renderer
        } catch {
            onFailure(error.localizedDescription)
        }
        return view
    }

    func updateUIView(_ view: MTKView, context: Context) {}
}
