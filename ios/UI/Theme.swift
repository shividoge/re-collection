import SwiftUI
import UIKit

/// The colors and small building blocks every screen shares, so the app reads as one thing.
enum Brand {
    /// The same red-orange as the website.
    static let accent = Color(red: 1.0, green: 0.36, blue: 0.23)
    static let good = Color(red: 0.38, green: 0.83, blue: 0.58)
    static let warn = Color(red: 1.0, green: 0.70, blue: 0.28)
    static let card = Color.white.opacity(0.07)
}

/// A light tap on the important moments, so you know the phone heard you without looking.
enum Haptics {
    static func tap() { UIImpactFeedbackGenerator(style: .medium).impactOccurred() }
    static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func warning() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
}

/// One big, obvious button per screen. `tint` is the accent unless the action is a recording.
struct BigButtonStyle: ButtonStyle {
    var tint: Color = Brand.accent

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.title3.weight(.semibold))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, minHeight: 58)
            .background(tint.opacity(configuration.isPressed ? 0.75 : 1), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

/// "Step 2 of 3: Film the visit": where you are, always visible.
struct StepBar: View {
    let step: Int
    private static let titles = ["Scan the room", "Film the visit", "Review and send"]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                ForEach(1...3, id: \.self) { index in
                    Capsule()
                        .fill(index <= step ? Brand.accent : Color.white.opacity(0.18))
                        .frame(height: 5)
                }
            }
            Text("Step \(step) of 3 · \(Self.titles[step - 1])")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
        }
    }
}

/// A short instruction that changes with what the phone is seeing. `warning` makes it amber.
struct CoachCard: View {
    let icon: String
    let text: String
    var warning = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(warning ? Brand.warn : Brand.accent)
                .frame(width: 26)
            Text(text)
                .font(.callout.weight(.medium))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(warning ? Brand.warn.opacity(0.6) : Color.clear, lineWidth: 1))
        .animation(.easeInOut(duration: 0.25), value: text)
    }
}

/// A red dot that breathes while recording.
struct RecordingDot: View {
    @State private var dim = false

    var body: some View {
        Circle()
            .fill(Color.red)
            .frame(width: 12, height: 12)
            .opacity(dim ? 0.25 : 1)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) { dim = true }
            }
    }
}
