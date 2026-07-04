var exec = require('cordova/exec');

var ColdStartIosFix = {
    /**
     * Registers a callback that fires with the launch / deep-link URL,
     * whether the app was cold-started via that URL or the URL arrived
     * while the app was already running.
     *
     * Safe to call as soon as `deviceready` fires. If the app was cold
     * launched via a URL, it may take a brief moment (until the WebView
     * finishes its initial page load) before the callback fires — that
     * delay is exactly the race this plugin works around.
     *
     * @param {function(url: string)} callback
     */
    onLaunchUrl: function (callback) {
        exec(callback, null, 'ColdStartIosFix', 'watchLaunchUrl', []);
    }
};

module.exports = ColdStartIosFix;