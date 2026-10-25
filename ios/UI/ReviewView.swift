import AVKit
import SwiftUI

/// After recording: play the clip back, name the moment, list who was there,
/// then upload through Convex or AirDrop the zip (IOS_CAPTURE_PLAN.md 8–9).
struct ReviewView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var uploads: UploadCenter
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
                    HStack(spacing: 10) {
                        statTile("Length", Self.formatTime(capture.manifest.video.durationSec), "clock")
                        statTile("Room points", capture.manifest.room.map { Self.compact($0.points) } ?? "none", "cube.transparent")
                        statTile("Stills", "\(capture.manifest.keyframes?.count ?? 0)", "photo.stack")
                    }
                    .listRowInsets(EdgeInsets(top: 10, leading: 0, bottom: 10, trailing: 0))
                    .listRowBackground(Color.clear)
                }

                Section {
                    // Locked while uploading: manifest.json is one of the files going up.
                    TextField("Sunday lunch at Mom's", text: $title)
                        .focused($editing)
                        .disabled(isUploading)
                    TextField("Priya, Dev, Grandma", text: $attendees, axis: .vertical)
                        .focused($editing)
                        .textInputAutocapitalization(.words)
                        .disabled(isUploading)
                    if let saveError = model.saveError {
                        Text(saveError).foregroundStyle(.red)
                    }
                } header: {
                    Text("Name this moment")
                } footer: {
                    Text("Names come from you, never from faces. Separate them with commas. The title and names help Claude describe the visit.")
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
            .navigationTitle(title.isEmpty ? "Your visit" : title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Finish") { confirmsLeaving = true }
                }
                ToolbarItem(placement: .keyboard) {
                    Button("Save") { editing = false }
                }
            }
            .safeAreaInset(edge: .top) {
                StepBar(step: 3)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.bar)
            }
            .onChange(of: myUpload) { _, state in
                if state == .done { Haptics.success() }
            }
            .confirmationDialog("Leave the review?", isPresented: $confirmsLeaving, titleVisibility: .visible) {
                Button("Leave") { model.finishReview() }
            } message: {
                switch myUpload {
                case .done: Text("The visit is uploaded.")
                case .uploading: Text("It keeps uploading in the background. Home shows how it's going.")
                default: Text("It hasn't been uploaded. It stays on the phone in the Files app.")
                }
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

    /// This capture's upload. Another capture's upload counts as not started here.
    private var myUpload: UploadCenter.State {
        uploads.captureId == capture.id ? uploads.state : .idle
    }

    private var isUploading: Bool {
        if case .uploading = myUpload { return true }
        return false
    }

    @ViewBuilder
    private var uploadRow: some View {
        switch myUpload {
        case .idle:
            Button {
                Haptics.tap()
                startUpload()
            } label: {
                Label("Send to your family's Braindance", systemImage: "icloud.and.arrow.up")
            }
            .buttonStyle(BigButtonStyle())
            .disabled(uploads.isUploading)
            .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 8, trailing: 0))
            .listRowBackground(Color.clear)
            if uploads.isUploading {
                Text("Another visit is still uploading. Send this one when it's done.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        case .uploading(let progress):
            VStack(alignment: .leading, spacing: 6) {
                ProgressView(value: progress.fraction)
                Text(progress.fileCount > 0
                     ? "Uploading… \(Int(progress.fraction * 100))% (\(progress.filesDone) of \(progress.fileCount) files)"
                     : "Starting the upload…")
                    .font(.footnote).foregroundStyle(.secondary)
                Text("It keeps going if you lock the phone or leave the app.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        case .done:
            Label("Sent. Braindance checked every file.", systemImage: "checkmark.circle.fill")
                .foregroundStyle(Brand.good)
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
        if uploads.convexURL.trimmingCharacters(in: .whitespaces).isEmpty {
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

    private func statTile(_ title: String, _ value: String, _ icon: String) -> some View {
        VStack(spacing: 4) {
            Image(systemName: icon).foregroundStyle(Brand.accent)
            Text(value).font(.headline.monospacedDigit())
            Text(title).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .background(Brand.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private static func compact(_ count: Int) -> String {
        if count >= 1_000_000 { return String(format: "%.1fM", Double(count) / 1_000_000) }
        if count >= 1_000 { return "\(count / 1_000)k" }
        return "\(count)"
    }

    private static func formatTime(_ seconds: Double) -> String {
        let whole = max(0, Int(seconds.rounded(.down)))
        return String(format: "%d:%02d", whole / 60, whole % 60)
    }
}
