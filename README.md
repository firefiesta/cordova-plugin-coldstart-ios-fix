# cordova-plugin-coldstart-ios-fix

[![npm version](https://img.shields.io/npm/v/cordova-plugin-coldstart-ios-fix.svg)](https://www.npmjs.com/package/cordova-plugin-coldstart-ios-fix)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Fixes a **cordova-ios cold-start bug**: opening the app via a custom URL
scheme or a Universal Link is silently dropped when the app is launched
from a fully killed state (cold start), because the `SceneDelegate`
receives the launch URL **before** Cordova's own open-URL observer has
been registered. The exact same link works fine when the app is already
running (warm start).

Tracked upstream at **[apache/cordova-ios#1671 — "iOS: custom-scheme deep link dropped on cold launch under UIScene (notification posted before CDVHandleOpenURL registers its observer)"](https://github.com/apache/cordova-ios/issues/1671)**.
That thread is the primary reference for this plugin — it's where the bug
was diagnosed and where the buffering workaround this plugin implements
was originally suggested.

Reproduced and reported on cordova-ios `8.1.0`, but the root cause is
architectural — it comes from `CDVSceneDelegate`, introduced in
[cordova-ios `8.0.0`](https://cordova.apache.org/announcements/2025/11/23/cordova-ios-8.0.0.html)
— so it affects every `8.x` release, not just `8.1.0`. Downgrading to
`8.0.1` does **not** fix it: the [8.0.1 release notes](https://cordova.apache.org/announcements/2026/03/12/cordova-ios-8.0.1.html)
only cover unrelated fixes (embedded frameworks,
`WKWebView.convertFilePath()` / `FileEntry.getUrl()`, a custom-scheme
cancel crash).

This affects, at minimum:
- **Custom URL scheme opens** (`myscheme://...`), e.g. via
  `cordova-plugin-customurlscheme`.
- **Universal Links**.
- **"Open in → YourApp" file imports**, since iOS delivers those the same
  way — as a URL to `scene(_:willConnectTo:options:)` — so any file-import
  flow built on `window.launch_url` / `window.handleOpenURL` is silently
  broken on cold start too, even though it looks unrelated to "deep
  linking" at first glance.

## The bug, in short

1. iOS launches the app from a killed state via `myscheme://...` or a
   Universal Link.
2. `scene(_:willConnectTo:options:)` fires with the URL — but Cordova's
   internal open-URL observer (`CDVHandleOpenURL`) doesn't exist yet at
   this point in the boot sequence.
3. The notification Cordova posts internally has no listener, so the URL
   is discarded in native code, before it ever reaches JavaScript.
4. Your app's `window.handleOpenURL`, deep-link plugin, or custom file
   handler never fires. There's no error — the URL is just gone.

## What this plugin does

It installs a small custom `SceneDelegate` (a subclass of
`CDVSceneDelegate`, so all default Cordova behaviour is preserved) that:

1. Captures the cold-launch URL in `scene(_:willConnectTo:options:)`
   instead of letting it get lost.
2. Waits until the WebView has finished loading the page
   (`CDVPageDidLoadNotification`) — by which point Cordova's plugins and
   observers are guaranteed to exist.
3. Replays the URL through Cordova's own notification
   (`CDVPluginHandleOpenURLNotification`, i.e. `window.handleOpenURL`
   keeps working if you already use it) **and** exposes it through a
   small JS API that is guaranteed to fire exactly once per launch URL,
   with no race condition.

Warm starts are untouched — they already work correctly in stock
cordova-ios, so this plugin just delegates to the default behaviour in
that case.

## Install

```bash
cordova plugin add cordova-plugin-coldstart-ios-fix
```

or from source:

```bash
cordova plugin add https://github.com/firefiesta/cordova-plugin-coldstart-ios-fix.git
```

Requires `cordova-ios >= 8.0.0`. iOS only — installing it in a project
that also targets Android is safe; the plugin simply does not add
anything on that platform.

## Usage

```js
document.addEventListener('deviceready', function () {
    cordova.plugins.coldStartIosFix.onLaunchUrl(function (url) {
        console.log('Launch URL:', url);
        // e.g. route the app, or hand the URL to your own file-import /
        // deep-link handler, regardless of whether this was a cold or
        // warm start.
    });
}, false);
```

- The callback fires **once per received URL**, cold or warm start.
- It is safe to register the listener as soon as `deviceready` fires —
  if the URL already arrived before you registered (should not normally
  happen, but the plugin buffers it natively just in case), it is
  delivered immediately on registration instead of being lost.
- If you already rely on the classic `window.handleOpenURL` global
  (e.g. via `cordova-plugin-customurlscheme`), you don't have to change
  anything — this plugin also replays through
  `CDVPluginHandleOpenURLNotification`, so that mechanism keeps working
  too. `onLaunchUrl` is provided as a more predictable alternative.

## Does this also fix push notification cold start?

Not by itself, and this plugin does not touch any push plugin's code.
Push notification payloads on cold start are delivered through a
completely different native path (`UNUserNotificationCenter` /
`didFinishLaunchingWithOptions`'s `UIApplicationLaunchOptionsRemoteNotificationKey`),
owned by whichever push plugin you use (`cordova-plugin-firebasex`,
`cordova-plugin-push`, etc.), not by `SceneDelegate`.

The symptom looks identical from the JS side (payload lost on cold
start, works fine on warm start / on tapping the notification while the
app is backgrounded) because it's the **same underlying pattern**: native
code delivers/dispatches the payload before your JS listener has had a
chance to register, and there is no replay mechanism, so it's gone for
good. This exact pattern has been reported for years across different
push plugins, independently of cordova-ios or the Scene lifecycle bug
above:

- [`phonegap/phonegap-plugin-push#50` — "iOS message is lost on cold start"](https://github.com/phonegap/phonegap-plugin-push/issues/50)
- [`phonegap/phonegap-plugin-push#758` — "push.on('notification') callback is not called on coldstart on iOS"](https://github.com/phonegap/phonegap-plugin-push/issues/758)
- [`havesource/cordova-plugin-push#181` — notifications not received after app start when subscribed to a topic](https://github.com/havesource/cordova-plugin-push/issues/181)
- [`dpa99c/cordova-plugin-firebasex#328` — adding a custom `openURL` handler (e.g. for Google Sign-In) stops `window.handleOpenURL` from firing](https://github.com/dpa99c/cordova-plugin-firebasex/issues/328) — relevant if you combine a push plugin with any URL-scheme-based SDK, since it shows the same "who owns the openURL/notification pipeline" conflict this plugin also has to deal with.
- [Pushwoosh Cordova integration guide — explicitly documents that the launch notification is lost if listeners aren't registered yet](https://docs.pushwoosh.com/developer/pushwoosh-sdk/cross-platform-frameworks/cordova/integration/basic-integration-guide)

If you're hitting that with your push plugin, the fix has to live in
that plugin's native code, and follows the same shape as
`AppSceneDelegate` in this repo:

1. In `AppDelegate`/the `UNUserNotificationCenterDelegate`, detect that
   the app was cold-launched by a notification tap.
2. Buffer the payload instead of dispatching it to JS immediately.
3. Replay it once `CDVPageDidLoadNotification` fires (or once
   `deviceready` has fired and your JS listener is registered) — not
   before.

PRs are very welcome if you want to contribute an equivalent buffering
plugin/module for a specific push provider (Firebase, OneSignal,
Pushwoosh, etc.) — happy to link it from here.

## Testing checklist

Test on a real device (the Simulator doesn't reliably reproduce push
delivery, and cold-start behaviour in general is more consistent on
device):

- [ ] Open a custom-scheme/Universal Link URL with the app **fully
  killed** (swiped away from the app switcher).
- [ ] Open the same URL with the app in the **background**.
- [ ] Open the same URL with the app in the **foreground**.

## How it works under the hood

See [`src/ios/AppSceneDelegate.swift`](./src/ios/AppSceneDelegate.swift) and
[`src/ios/ColdStartIosFix.swift`](./src/ios/ColdStartIosFix.swift) — both are
short and commented in detail.

The plugin ships an `after_prepare` hook
([`scripts/set-scene-delegate.js`](./scripts/set-scene-delegate.js)) that
rewrites `UISceneDelegateClassName` directly in the generated `Info.plist`
after every `cordova prepare`, pointing it at `AppSceneDelegate` instead of
the default generated `SceneDelegate`.

This is **not** done via a declarative `<edit-config>`, on purpose:
`UISceneDelegateClassName` lives inside a plist **array**
(`UIApplicationSceneManifest.UISceneConfigurations.UIWindowSceneSessionRoleApplication[0]`),
and Cordova's `edit-config`/`config-file` machinery cannot reliably patch a
value inside a plist array — indexed target paths aren't resolved, and
array changes get merged/concatenated rather than overwritten. This is a
long-standing, acknowledged limitation, not a guess — see
[apache/cordova-ios#613](https://github.com/apache/cordova-ios/issues/613)
and [CB-13496](https://issues.apache.org/jira/browse/CB-13496). The hook
sidesteps it entirely with a small, dependency-free text replacement: the
`UISceneDelegateClassName` line in Apple's plist XML is fully predictable,
so a targeted regex is enough — no plist-parsing npm package required, no
extra `npm install` step, nothing that can silently fail to resolve
depending on how the plugin was installed (local path, git URL, npm
registry). It works the instant the plugin is added.

The hook is idempotent — it only touches entries still pointing at the
default `*.SceneDelegate` class name, so running `cordova prepare` multiple
times, or combining this plugin with another one that also touches Scene
config, won't cause duplicate or conflicting rewrites (though if another
plugin also needs to customize `UISceneDelegateClassName`, only one of the
two will "win" — there's no dependency-injection mechanism here, just a
straight rewrite).

Since `AppSceneDelegate` subclasses `CDVSceneDelegate` and calls `super` in
every overridden method, it's safe to combine with other plugins that
don't also try to replace the Scene Delegate class.

## Contributing

Issues and PRs welcome — in particular:

- Reports confirming/denying the bug on other cordova-ios `8.x`
  versions.
- Equivalent buffering fixes for specific push notification plugins.

## References

**Custom URL scheme / file-open cold-start bug (what this plugin fixes):**
- [apache/cordova-ios#1671 — the upstream issue this plugin implements the workaround for](https://github.com/apache/cordova-ios/issues/1671)
- [apache/cordova-ios#613 — arrays in plist files can not be adjusted with edit-config (why this plugin uses a hook, not edit-config, to set the Scene Delegate class)](https://github.com/apache/cordova-ios/issues/613)
- [CB-13496 / apache/cordova-common@9c6cda3 — plist edit-config only supports merges of whole objects/arrays](https://issues.apache.org/jira/browse/CB-13496)
- [apache/cordova-ios releases](https://github.com/apache/cordova-ios/releases)
- [Cordova iOS 8.0.0 announcement — introduces `CDVSceneDelegate`](https://cordova.apache.org/announcements/2025/11/23/cordova-ios-8.0.0.html)
- [Cordova iOS 8.0.1 announcement — unrelated fixes, does not touch this bug](https://cordova.apache.org/announcements/2026/03/12/cordova-ios-8.0.1.html)
- [Cordova iOS `RELEASENOTES.md`](https://github.com/apache/cordova-ios/blob/master/RELEASENOTES.md)
- [Apple Developer Forums — `openURLContexts` not firing from `SceneDelegate` on cold launch](https://developer.apple.com/forums/thread/134099)
- [Jake Hao — "How to Implement Deep Link and ShortcutItems When Using SceneDelegate"](https://www.jakehao.com/scene-delegate-open-url)

**Push notification cold-start (same pattern, different native path — not fixed by this plugin):**
- [phonegap/phonegap-plugin-push#50](https://github.com/phonegap/phonegap-plugin-push/issues/50)
- [phonegap/phonegap-plugin-push#758](https://github.com/phonegap/phonegap-plugin-push/issues/758)
- [havesource/cordova-plugin-push#181](https://github.com/havesource/cordova-plugin-push/issues/181)
- [dpa99c/cordova-plugin-firebasex#328](https://github.com/dpa99c/cordova-plugin-firebasex/issues/328)
- [Pushwoosh Cordova SDK integration guide](https://docs.pushwoosh.com/developer/pushwoosh-sdk/cross-platform-frameworks/cordova/integration/basic-integration-guide)

## License

MIT © [firefiesta](https://github.com/firefiesta)