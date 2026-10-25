import SwiftUI

/// Guide server address (where captures upload) and room-scan options.
struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var check: CheckState = .idle

    private enum CheckState: Equatable {
        case idle, checking, ok(String), failed(String)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://….trycloudflare.com", text: $model.guideURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Key (if the guide has one)", text: $model.guideKey)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Guide server")
                } footer: {
                    Text("The URL cloudflared prints on the laptop running the guide. It changes every time the tunnel restarts.")
                }

                Section {
                    Button("Test connection") { Task { await testConnection() } }
                        .disabled(check == .checking || model.guideURL.isEmpty)
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

    /// GET /health, then GET /api/captures to prove the key works too.
    private func testConnection() async {
        check = .checking
        guard let health = UploadPlan.url(base: model.guideURL, path: "/health"),
              let captures = UploadPlan.url(base: model.guideURL, path: "/api/captures")
        else {
            check = .failed("That isn't a usable URL.")
            return
        }
        do {
            let (_, healthResponse) = try await URLSession.shared.data(from: health)
            guard (healthResponse as? HTTPURLResponse)?.statusCode == 200 else {
                check = .failed("The server answered, but it isn't the guide.")
                return
            }
            var request = URLRequest(url: captures)
            if !model.guideKey.isEmpty { request.setValue(model.guideKey, forHTTPHeaderField: "X-Braindance-Key") }
            let (_, response) = try await URLSession.shared.data(for: request)
            switch (response as? HTTPURLResponse)?.statusCode {
            case 200: check = .ok("Connected to the guide.")
            case 401: check = .failed("Connected, but the key is wrong.")
            case let code: check = .failed("Connected, but the guide answered HTTP \(code ?? 0).")
            }
        } catch {
            check = .failed(error.localizedDescription)
        }
    }
}
