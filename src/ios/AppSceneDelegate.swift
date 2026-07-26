import UIKit
import Cordova

/// Custom SceneDelegate that works around a cordova-ios cold-start bug
/// (see https://github.com/apache/cordova-ios/issues/1671):
///
/// On a cold launch via a custom URL scheme, a file open (GPX/TCX/FIT), or a
/// Universal Link, iOS delivers the launch data (URL contexts / NSUserActivity)
/// *before* Cordova's own observers have been registered. The notifications
/// Cordova and its plugins rely on internally are posted into a void —
/// nothing is listening yet — and the data is lost before it ever reaches
/// JavaScript.
///
/// This subclass buffers whatever cold-launch data iOS hands us (URL context
/// and/or user activity) and replays it once the WebView has finished
/// loading the page (`CDVPageDidLoadNotification`), by which point Cordova's
/// plugins and observers are guaranteed to exist.
///
/// Warm starts (app already running) are unaffected by the bug and are
/// simply passed through to the default Cordova behaviour.
@objc(AppSceneDelegate)
public class AppSceneDelegate: CDVSceneDelegate {

    private var pendingLaunchURL: URL?
    private var pendingLaunchUserActivity: NSUserActivity?
    private var pageLoadObserver: NSObjectProtocol?

    public override func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        super.scene(scene, willConnectTo: session, options: connectionOptions)

        let launchURL = connectionOptions.urlContexts.first?.url
        let launchUserActivity = connectionOptions.userActivities.first(where: {
            $0.activityType == NSUserActivityTypeBrowsingWeb && $0.webpageURL != nil
        })

        guard launchURL != nil || launchUserActivity != nil else {
            return
        }

        pendingLaunchURL = launchURL
        pendingLaunchUserActivity = launchUserActivity

        NSLog("[ColdStartFix-DEBUG] Cold start data buffered - url: %@, userActivity webpageURL: %@",
              launchURL?.absoluteString ?? "nil",
              launchUserActivity?.webpageURL?.absoluteString ?? "nil")

        pageLoadObserver = NotificationCenter.default.addObserver(
            forName: NSNotification.Name("CDVPageDidLoadNotification"),
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.replayPendingLaunchData()
        }
    }

    public override func scene(
        _ scene: UIScene,
        openURLContexts URLContexts: Set<UIOpenURLContext>
    ) {
        // Warm start: Cordova's observer is already registered, so the
        // stock behaviour works correctly here. No buffering needed.
        super.scene(scene, openURLContexts: URLContexts)
    }

    // Not overriding scene(_:continue:) on purpose: for warm starts,
    // CDVSceneDelegate's own implementation already posts
    // CDVPluginContinueUserActivityNotification correctly, so the default
    // (inherited) behaviour is what we want here.

    private func replayPendingLaunchData() {
        if let observer = pageLoadObserver {
            NotificationCenter.default.removeObserver(observer)
            pageLoadObserver = nil
        }

        if let url = pendingLaunchURL {
            pendingLaunchURL = nil

            NSLog("[ColdStartFix-DEBUG] Replaying buffered URL: %@", url.absoluteString)

            // 1. Replay through Cordova's own channel, for any code relying on
            //    window.handleOpenURL / CDVPluginHandleOpenURLNotification.
            NotificationCenter.default.post(
                name: NSNotification.Name("CDVPluginHandleOpenURLNotification"),
                object: url
            )
            // 2. Also notify our plugin directly, so apps that use this
            //    plugin's JS API get the URL even if nothing else is
            //    listening to the notification above.
            NotificationCenter.default.post(
                name: ColdStartIosFix.urlReceivedNotification,
                object: url
            )
        }

        if let userActivity = pendingLaunchUserActivity {
            pendingLaunchUserActivity = nil

            NSLog("[ColdStartFix-DEBUG] Replaying buffered userActivity webpageURL: %@",
                  userActivity.webpageURL?.absoluteString ?? "nil")

            // Same channel that CDVSceneDelegate uses for warm-start Universal
            // Links, so ionic-plugin-deeplinks' existing observer picks this
            // up without any extra wiring on the JS/plugin side.
            NotificationCenter.default.post(
                name: NSNotification.Name("CDVPluginContinueUserActivityNotification"),
                object: userActivity
            )
        }
    }
}