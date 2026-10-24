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
                    dimsCloud: model.isRecordingMoment,
                    onFPS: { fps in Task { @MainActor in model.previewFPS = fps } },
                    onFailure: { message in Task { @MainActor in model.fail(message) } })
                    .ignoresSafeArea()
            }

            VStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 12) {
                    StepBar(step: model.isRecordingMoment ? 2 : (isRoomDone ? 2 : 1))
                    coach
                }
                .padding(14)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))

                Spacer()

                controls
            }
            .padding()
        }
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
    }

    /// Done scanning: from here on the step is "film the visit".
    private var isRoomDone: Bool {
        if case .roomSaved = model.phase { return true }
        return false
    }

    /// What to do right now, in plain words, and a warning when tracking is weak.
    @ViewBuilder
    private var coach: some View {
        switch model.phase {
        case .scanningRoom:
            if let message = model.trackingMessage {
                CoachCard(icon: "exclamationmark.triangle.fill", text: "\(message) Slow down and aim at a wall or furniture.", warning: true)
            } else if model.pointCount < 20_000 {
                CoachCard(icon: "figure.walk", text: "Sweep slowly. Aim at the walls, floor and furniture. Dots appear where the sensor sees a surface.")
            } else if model.pointCount < 250_000 {
                CoachCard(icon: "arrow.triangle.2.circlepath", text: "Good start. Walk around the edges and point at anything you want in the room.")
            } else {
                CoachCard(icon: "checkmark.circle.fill", text: "That's plenty of room. Tap Save room when you've covered it.")
            }
            pointMeter
        case .savingRoom:
            CoachCard(icon: "externaldrive.fill", text: "Saving the room. One moment.")
        case .roomSaved(let export):
            CoachCard(icon: "person.2.fill", text: "Room saved (\(Self.formatPoints(export.pointCount))). Now let people in, then press record and let them talk.")
        case .recordingMoment:
            CoachCard(icon: "video.fill", text: "Filming. Hold the phone steady in landscape and move slowly. Speech is written down on this phone.")
        default:
            EmptyView()
        }
    }

    /// How much room has been captured so far, against a typical full room.
    private var pointMeter: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Room captured").font(.footnote.weight(.semibold))
                Spacer()
                Text(Self.formatPoints(model.pointCount)).font(.footnote.monospacedDigit()).foregroundStyle(.secondary)
            }
            ProgressView(value: min(1, Double(model.pointCount) / 400_000))
                .tint(Brand.accent)
        }
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
            panel {
                Button {
                    Haptics.tap()
                    model.recordMoment()
                } label: {
                    Label("Record the visit", systemImage: "record.circle")
                }
                .buttonStyle(BigButtonStyle(tint: .red))
                HStack(spacing: 16) {
                    ShareLink(items: [export.plyURL, export.binURL]) {
                        Label("Share room", systemImage: "square.and.arrow.up")
                    }
                    Button("Done") { model.stopScan() }
                }
                .buttonStyle(.bordered)
                .controlSize(.regular)
            }

        case .recordingMoment(let startedAt):
            panel {
                TimelineView(.periodic(from: startedAt, by: 1)) { context in
                    let elapsed = max(0, Int(context.date.timeIntervalSince(startedAt)))
                    VStack(spacing: 8) {
                        HStack(spacing: 10) {
                            RecordingDot()
                            Text(Self.formatTime(elapsed))
                                .font(.system(size: 40, weight: .bold).monospacedDigit())
                            Text("of 3:00").font(.callout).foregroundStyle(.secondary)
                        }
                        ProgressView(value: min(1, Double(elapsed) / 180)).tint(.red)
                    }
                }
                Button {
                    Haptics.success()
                    model.stopMoment()
                } label: {
                    Label("Stop recording", systemImage: "stop.fill")
                }
                .buttonStyle(BigButtonStyle(tint: .red))
            }

        default:
            panel {
                Button {
                    Haptics.success()
                    model.finishScan()
                } label: {
                    Label("Save room", systemImage: "checkmark")
                }
                .buttonStyle(BigButtonStyle())
                .disabled(model.pointCount < 2_000)
                .opacity(model.pointCount < 2_000 ? 0.45 : 1)

                HStack(spacing: 12) {
                    Button(model.showsCameraFeed ? "Show dots only" : "Show camera") {
                        model.showsCameraFeed.toggle()
                    }
                    .buttonStyle(.bordered)
                    Button("Cancel", role: .destructive) { model.stopScan() }
                        .buttonStyle(.bordered)
                }
                .controlSize(.regular)
            }
        }
    }

    private func panel<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(spacing: 12, content: content)
            .padding()
            .frame(maxWidth: 420)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20))
    }

    private static func formatTime(_ seconds: Int) -> String {
        String(format: "%d:%02d", seconds / 60, seconds % 60)
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
    let dimsCloud: Bool
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
            renderer.dimsCloud = dimsCloud
            context.coordinator.renderer = renderer
            view.delegate = renderer
        } catch {
            onFailure(error.localizedDescription)
        }
        return view
    }

    func updateUIView(_ view: MTKView, context: Context) {
        context.coordinator.renderer?.showsCameraFeed = showsCameraFeed
        context.coordinator.renderer?.dimsCloud = dimsCloud
    }
}
