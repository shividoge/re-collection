import SwiftUI

@main
struct BraindanceCaptureApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            HomeView()
                .environmentObject(model)
                .preferredColorScheme(.dark)
        }
        .onChange(of: scenePhase) { _, newPhase in
            // A capture can't survive backgrounding: ARKit pauses and the
            // world frame may shift, so fail it instead of resuming.
            if newPhase != .active {
                model.appLeftForeground()
            }
        }
    }
}
