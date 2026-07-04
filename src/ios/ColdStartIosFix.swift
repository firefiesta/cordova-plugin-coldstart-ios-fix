import Foundation
import Cordova

/// Bridges the launch URL buffered by AppSceneDelegate to JavaScript.
///
/// JS registers a persistent callback via `watchLaunchUrl`. If the URL
/// already arrived before JS had a chance to register (e.g. the WebView
/// took slightly longer than usual to load), it is flushed immediately
/// on registration instead of being lost.
@objc(ColdStartIosFix)
public class ColdStartIosFix: CDVPlugin {

    static let urlReceivedNotification = NSNotification.Name("ColdStartIosFixURLReceived")

    private var callbackId: String?
    private var bufferedURL: URL?

    public override func pluginInitialize() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(onURLReceived(_:)),
            name: ColdStartIosFix.urlReceivedNotification,
            object: nil
        )
    }

    @objc func onURLReceived(_ notification: Notification) {
        guard let url = notification.object as? URL else {
            return
        }

        if callbackId != nil {
            sendURLToJS(url)
        } else {
            // JS hasn't registered its listener yet — hold onto it.
            bufferedURL = url
        }
    }

    @objc(watchLaunchUrl:)
    func watchLaunchUrl(command: CDVInvokedUrlCommand) {
        callbackId = command.callbackId

        if let url = bufferedURL {
            bufferedURL = nil
            sendURLToJS(url)
        }
    }

    private func sendURLToJS(_ url: URL) {
        guard let callbackId = callbackId else {
            return
        }

        let result = CDVPluginResult(status: .ok, messageAs: url.absoluteString)
        result?.setKeepCallbackAs(true)
        self.commandDelegate.send(result, callbackId: callbackId)
    }
}