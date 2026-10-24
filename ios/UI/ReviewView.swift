import AVKit
import SwiftUI

/// After recording: play the clip back, name the moment, list who was there,
/// then upload to the guide or AirDrop the zip (IOS_CAPTURE_PLAN.md 8–9).
struct ReviewView: View {
    @EnvironmentObject private var model: AppModel
    let capture: SavedCapture

    @State private var title = ""
    @State private var attendees = ""
    @State private var player: AVPlayer?
    @State private var showsSettings = false
    @State private var confirmsLeaving = false
    @FocusState private var editing: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VideoPlayer(player: player)
                        .aspectRatio(4.0 / 3.0, contentMode: .fit)
                        .listRowInsets(EdgeInsets())
                    LabeledContent("Length", value: Self.formatTime(capture.manifest.video.durationSec))
                    LabeledContent("Room points", value: capture.manifest.room.map { "\($0.points.formatted())" } ?? "none")
                    LabeledContent("Keyframes", value: "\(capture.manifest.keyframes?.count ?? 0)")
                }

                Section {
                    TextField("Sunday lunch at Mom's", text: $title)
                        .focused($editing)
                    TextField("Priya, Dev, Grandma", text: $attendees, axis: .vertical)
                        .focused($editing)
                        .textInputAutocapitalization(.words)
                } header: {
                    Text("About this moment")
                } footer: {
                    Text("Names come from you, never from faces. Separate them with commas.")
                }

                Section("What the phone heard") {
                    if let transcript = capture.transcript {
                        if transcript.segments.isEmpty {
                            Text("No speech detected.").foregroundStyle(.secondary)
                        } else {
                            ForEach(Array(transcript.segments.enumerated()), id: \.offset) { _, segment in
                                Button {
                                    player?.seek(to: CMTime(seconds: segment.start, preferredTimescale: 600))
                                    player?.play()
                                } label: {
                                    HStack(alignment: .firstTextBaseline) {
                                        Text(Self.formatTime(segment.start)).monospacedDigit().foregroundStyle(.secondary)
                                        Text(segment.text).foregroundStyle(.primary)
                                    }
                                }
                            }
                        }
                    } else {
                        Text("No transcript for this visit.").foregroundStyle(.secondary)
                    }
                }

                if !capture.manifest.warnings.isEmpty {
                    Section("Warnings") {
                        ForEach(capture.manifest.warnings, id: \.self) { Text($0).foregroundStyle(.orange) }
                    }
                }

                Section {
                    uploadRow
                    ShareLink(item: CaptureArchive(folder: capture.folder),
                              preview: SharePreview("Braindance capture \(capture.id.prefix(8))")) {
                        Label("AirDrop the capture (zip)", systemImage: "square.and.arrow.up")
                    }
                } footer: {
                    Text("The capture also stays on this phone: Files > On My iPhone > Braindance > captures.")
                }
            }
            .navigationTitle(title.isEmpty ? "Review the visit" : title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { confirmsLeaving = true }
                        .disabled(isUploading)
                }
                ToolbarItem(placement: .keyboard) {
                    Button("Save") { editing = false }
                }
            }
            .confirmationDialog("Leave the review?", isPresented: $confirmsLeaving, titleVisibility: .visible) {
                Button("Leave") { model.finishReview() }
            } message: {
                Text(model.upload == .done ? "The visit is uploaded." : "It hasn't been uploaded. It stays on the phone in the Files app.")
            }
            .sheet(isPresented: $showsSettings) { SettingsView() }
        }
        .onAppear {
            title = capture.manifest.title
            attendees = capture.manifest.attendees.joined(separator: ", ")
            player = AVPlayer(url: capture.videoURL)
            UIApplication.shared.isIdleTimerDisabled = true
        }
        .onDisappear {
            player?.pause()
            UIApplication.shared.isIdleTimerDisabled = false
        }
        .onChange(of: editing) { _, isEditing in
            if !isEditing { saveDetails() }
        }
    }

    private var isUploading: Bool {
        if case .uploading = model.upload { return true }
        return false
    }

    @ViewBuilder
    private var uploadRow: some View {
        switch model.upload {
        case .idle:
            Button {
                startUpload()
            } label: {
                Label("Upload to the guide", systemImage: "icloud.and.arrow.up")
            }
        case .uploading(let progress):
            VStack(alignment: .leading, spacing: 6) {
                ProgressView(value: progress.fraction)
                Text("Uploading \(progress.currentFile)… \(Int(progress.fraction * 100))%")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        case .done:
            Label("Uploaded. The guide checked every file.", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
        case .failed(let message):
            VStack(alignment: .leading, spacing: 8) {
                Label(message, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red)
                HStack {
                    Button("Try again") { startUpload() }
                    Spacer()
                    Button("Settings") { showsSettings = true }
                }
                .buttonStyle(.borderless)
            }
        }
    }

    private func startUpload() {
        saveDetails()
        if model.guideURL.isEmpty {
            showsSettings = true
        } else {
            model.uploadCapture()
        }
    }

    private func saveDetails() {
        let names = attendees
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        model.saveDetails(title: title, attendees: names)
    }

    private static func formatTime(_ seconds: Double) -> String {
        let whole = max(0, Int(seconds.rounded(.down)))
        return String(format: "%d:%02d", whole / 60, whole % 60)
    }
}
