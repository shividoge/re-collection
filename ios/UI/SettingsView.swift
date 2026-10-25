import SwiftUI

/// Where captures upload (the Convex deployment) and room-scan options.
struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var uploads: UploadCenter
    @Environment(\.dismiss) private var dismiss
    @State private var check: CheckState = .idle

    private enum CheckState: Equatable {
        case idle, checking, ok(String), failed(String)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(ConvexClient.defaultURL, text: $uploads.convexURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    if uploads.convexURL != ConvexClient.defaultURL {
                        Button("Use the team's deployment") { uploads.convexURL = ConvexClient.defaultURL }
                    }
                } header: {
                    Text("Upload to")
                } footer: {
                    Text("The Braindance Convex deployment. Files go from the phone straight to storage and keep uploading when the phone is locked.")
                }

                Section {
                    Button("Test connection") { Task { await testConnection() } }
                        .disabled(check == .checking || uploads.convexURL.trimmingCharacters(in: .whitespaces).isEmpty)
                    switch check {
                    case .idle: EmptyView()
                    case .checking: ProgressView()
                    case .ok(let message): Label(message, systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    case .failed(let message): Label(message, systemImage: "xmark.octagon.fill").foregroundStyle(.red)
                    }
                }

                Section {
                    Toggle("Keep medium-confidence depth", isOn: $model.keepMediumConfidence)
                } header: {
                    Text("Room scan")
                } footer: {
                    Text("Adds weaker LiDAR points within 3 m. Try it for glossy surfaces or bright light; it can add noise. Applies to the next scan.")
                }
            }
            .navigationTitle("Settings")
            .toolbar { Button("Done") { dismiss() } }
        }
    }

    /// Calls the `system:health` query.
    private func testConnection() async {
        check = .checking
        do {
            try await ConvexClient(baseURL: uploads.convexURL).health()
            check = .ok("Connected to Braindance.")
        } catch {
            check = .failed(error.localizedDescription)
        }
    }
}
