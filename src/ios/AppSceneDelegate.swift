import UIKit
import Cordova

/// Custom SceneDelegate that works around a cordova-ios cold-start bug
/// (see https://github.com/apache/cordova-ios/issues/1671):
///
/// On a cold launch via a custom URL scheme or Universal Link, iOS calls
/// `scene(_:willConnectTo:options:)` *before* Cordova's own open-URL
/// observer (`CDVHandleOpenURL`) has been registered. The notification
/// Cordova relies on internally is posted into a void — nothing is
/// listening yet — and the URL is lost before it ever reaches JavaScript.
///
/// This subclass buffers the cold-launch URL and replays it once the
/// WebView has finished loading the page (`CDVPageDidLoadNotification`),
/// by which point Cordova's plugins and observers are guaranteed to exist.
///
/// Warm starts (app already running) are unaffected by the bug and are
/// simply passed through to the default Cordova behaviour.
@objc(AppSceneDelegate)
public class AppSceneDelegate: CDVSceneDelegate {

    private var pendingLaunchURL: URL?
    private var pageLoadObserver: NSObjectProtocol?

    public override func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        super.scene(scene, willConnectTo: session, options: connectionOptions)

        guard let url = connectionOptions.urlContexts.first?.url else {
            return
        }

        pendingLaunchURL = url

        pageLoadObserver = NotificationCenter.default.addObserver(
            forName: NSNotification.Name("CDVPageDidLoadNotification"),
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.replayPendingLaunchURL()
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

    private func replayPendingLaunchURL() {
        guard let url = pendingLaunchURL else {
            return
        }

        pendingLaunchURL = nil

        if let observer = pageLoadObserver {
            NotificationCenter.default.removeObserver(observer)
            pageLoadObserver = nil
        }

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
}