import SwiftUI
import UIKit

@main
struct BraindanceCaptureApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            HomeView()
                .environmentObject(model)
                .environmentObject(UploadCenter.shared)
                .preferredColorScheme(.dark)
        }
        .onChange(of: scenePhase) { _, newPhase in
            // A capture can't survive backgrounding: ARKit pauses and the
            // world frame may shift, so fail it instead of resuming.
            // Uploads carry on in the background.
            if newPhase != .active {
                model.appLeftForeground()
            }
        }
    }
}

/// Reconnects to the background upload session at launch and hands iOS's
/// "your uploads have news" wake-ups to it.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        BackgroundTransfers.shared.onEventsDelivered = { UploadCenter.shared.backgroundEventsDelivered() }
        UploadCenter.shared.resumePending()
        return true
    }

    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        guard identifier == BackgroundTransfers.identifier else {
            completionHandler()
            return
        }
        // Called once the session has delivered every event (BackgroundTransfers).
        BackgroundTransfers.shared.systemCompletion = completionHandler
    }
}
