import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var model: AppModel
    @State private var showsSettings = false

    var body: some View {
        if !model.isDeviceSupported {
            MessageView(
                title: "This device can't capture",
                message: "Braindance needs an iPhone or iPad with LiDAR. It doesn't run in the simulator.")
        } else {
            switch model.phase {
            case .idle:
                idle
            case .scanningRoom, .savingRoom, .roomSaved, .recordingMoment:
                ScanView()
            case .savingMoment(let step):
                VStack(spacing: 18) {
                    ProgressView().controlSize(.large).tint(Brand.accent)
                    Text("Putting your visit together").font(.title2.bold())
                    Text(step).font(.body).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Text("Keep the app open. This takes under a minute.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                .padding(32)
            case .review(let capture):
                ReviewView(capture: capture)
            case .failed(let message):
                MessageView(title: "Capture stopped", message: message) {
                    model.dismissFailure()
                }
            }
        }
    }

    private var idle: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                HStack {
                    HStack(spacing: 10) {
                        Image(systemName: "viewfinder.circle.fill")
                            .font(.title)
                            .foregroundStyle(Brand.accent)
                        Text("Braindance").font(.title2.bold())
                    }
                    Spacer()
                    Button { showsSettings = true } label: {
                        Image(systemName: "gearshape.fill")
                            .font(.title3)
                            .foregroundStyle(.secondary)
                            .padding(10)
                    }
                    .accessibilityLabel("Settings")
                }

                VStack(alignment: .leading, spacing: 10) {
                    Text("Film a visit.\nThey can walk back into it.")
                        .font(.system(size: 34, weight: .bold))
                        .fixedSize(horizontal: false, vertical: true)
                    Text("Your phone's LiDAR scans the room and records the moment. Braindance turns it into a place someone with Alzheimer's can revisit.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }

                VStack(spacing: 12) {
                    stepRow(1, "cube.transparent", "Scan the room", "Walk slowly. Dots appear wherever the phone sees a surface.")
                    stepRow(2, "video.fill", "Film the visit", "Up to 3 minutes. Speech is written down on this phone, not sent anywhere.")
                    stepRow(3, "paperplane.fill", "Review and send", "Name the moment, check it, and send it to your family's guide.")
                }

                VStack(alignment: .leading, spacing: 8) {
                    Label("For a clean scan", systemImage: "lightbulb.fill")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Brand.warn)
                    Text("Scan before people arrive. Stay 1 to 3 m from the walls and move slowly. Avoid direct sunlight and shiny floors; they hide surfaces from LiDAR.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Brand.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))

                VStack(spacing: 12) {
                    Button {
                        Haptics.tap()
                        model.startScan()
                    } label: {
                        Label("Start scanning", systemImage: "viewfinder")
                    }
                    .buttonStyle(BigButtonStyle())

                    Button { showsSettings = true } label: {
                        HStack(spacing: 6) {
                            Image(systemName: model.guideURL.isEmpty ? "icloud.slash" : "checkmark.icloud.fill")
                                .foregroundStyle(model.guideURL.isEmpty ? Color.secondary : Brand.good)
                            Text(model.guideURL.isEmpty ? "Upload isn't set up. You can still AirDrop the capture." : "Uploads to your family's guide")
                        }
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(20)
        }
        .sheet(isPresented: $showsSettings) { SettingsView() }
    }

    private func stepRow(_ number: Int, _ icon: String, _ title: String, _ detail: String) -> some View {
        HStack(spacing: 14) {
            ZStack {
                Circle().fill(Brand.accent.opacity(0.18)).frame(width: 46, height: 46)
                Image(systemName: icon).foregroundStyle(Brand.accent)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text("\(number). \(title)").font(.headline)
                Text(detail).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(Brand.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
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
