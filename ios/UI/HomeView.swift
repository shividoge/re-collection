import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        if !model.isDeviceSupported {
            MessageView(
                title: "This device can't capture",
                message: "Braindance needs an iPhone or iPad with LiDAR. It doesn't run in the simulator.")
        } else {
            switch model.phase {
            case .idle:
                idle
            case .scanningRoom, .savingRoom, .roomSaved:
                ScanView()
            case .failed(let message):
                MessageView(title: "Capture stopped", message: message) {
                    model.dismissFailure()
                }
            }
        }
    }

    private var idle: some View {
        VStack(spacing: 24) {
            Text("Braindance")
                .font(.largeTitle.bold())
            Text("Scan the room first, before people gather.")
                .foregroundStyle(.secondary)
            Button("Scan the room") { model.startScan() }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
        }
        .padding()
    }
}

struct MessageView: View {
    let title: String
    let message: String
    var onDismiss: (() -> Void)?

    var body: some View {
        VStack(spacing: 16) {
            Text(title).font(.title2.bold())
            Text(message)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            if let onDismiss {
                Button("OK", action: onDismiss).buttonStyle(.bordered)
            }
        }
        .padding(32)
    }
}
