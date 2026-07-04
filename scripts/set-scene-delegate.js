#!/usr/bin/env node

/**
 * Cordova's edit-config cannot reliably patch a value living *inside* an
 * array of a plist file (see apache/cordova-ios#613 / CB-13496: array
 * changes are merged/concatenated rather than overwritten, and indexed
 * paths like ".../0/UISceneDelegateClassName" are not resolved at all).
 *
 * UISceneDelegateClassName lives inside
 *   UIApplicationSceneManifest.UISceneConfigurations.UIWindowSceneSessionRoleApplication[0]
 * — exactly the kind of nested array entry edit-config can't touch safely.
 *
 * So instead of declaring an <edit-config>, this hook runs after every
 * `cordova prepare` and rewrites the generated Info.plist directly,
 * pointing the Scene Delegate class at AppSceneDelegate (this plugin's
 * CDVSceneDelegate subclass) instead of the default generated SceneDelegate.
 */

const fs = require('fs');
const path = require('path');

module.exports = function (context) {
    const plist = requirePlist(context);
    if (!plist) {
        return;
    }

    const projectRoot = context.opts.projectRoot;
    const iosPlatformRoot = path.join(projectRoot, 'platforms', 'ios');

    if (!fs.existsSync(iosPlatformRoot)) {
        // iOS platform not added — nothing to do.
        return;
    }

    const infoPlistPath = findInfoPlist(iosPlatformRoot);
    if (!infoPlistPath) {
        console.warn('[cordova-plugin-coldstart-ios-fix] Info.plist not found, skipping Scene Delegate patch.');
        return;
    }

    let data;
    try {
        data = plist.parse(fs.readFileSync(infoPlistPath, 'utf8'));
    } catch (err) {
        console.warn('[cordova-plugin-coldstart-ios-fix] Failed to parse Info.plist: ' + err.message);
        return;
    }

    const manifest = data.UIApplicationSceneManifest;
    const configs = manifest &&
        manifest.UISceneConfigurations &&
        manifest.UISceneConfigurations.UIWindowSceneSessionRoleApplication;

    if (!Array.isArray(configs)) {
        console.warn('[cordova-plugin-coldstart-ios-fix] UIApplicationSceneManifest not found or unexpected shape, skipping.');
        return;
    }

    let changed = false;

    configs.forEach((sceneConfig) => {
        const currentClass = sceneConfig.UISceneDelegateClassName;
        if (typeof currentClass !== 'string') {
            return;
        }

        // Only touch entries still pointing at the default generated
        // SceneDelegate, so re-running this hook is idempotent and it
        // won't clobber a class name some other plugin/dev intentionally set.
        if (currentClass.endsWith('.SceneDelegate') || currentClass === 'SceneDelegate') {
            const moduleName = currentClass.includes('.')
                ? currentClass.substring(0, currentClass.lastIndexOf('.'))
                : '$(PRODUCT_MODULE_NAME)';

            sceneConfig.UISceneDelegateClassName = moduleName + '.AppSceneDelegate';
            changed = true;
        }
    });

    if (!changed) {
        console.log('[cordova-plugin-coldstart-ios-fix] UISceneDelegateClassName already set to AppSceneDelegate (or no matching entry found) — no changes made.');
        return;
    }

    fs.writeFileSync(infoPlistPath, plist.build(data));
    console.log('[cordova-plugin-coldstart-ios-fix] Patched UISceneDelegateClassName -> AppSceneDelegate in ' + infoPlistPath);
};

function requirePlist(context) {
    try {
        // Installed as a dependency of this plugin's own package.json —
        // Cordova runs `npm install` inside the plugin folder on add.
        return require('plist');
    } catch (err) {
        console.warn(
            '[cordova-plugin-coldstart-ios-fix] Could not load the "plist" module (' + err.message + '). ' +
            'Try running `npm install` inside plugins/cordova-plugin-coldstart-ios-fix, or reinstalling the plugin.'
        );
        return null;
    }
}

function findInfoPlist(iosPlatformRoot) {
    // cordova-ios 8+: platforms/ios/App/App-Info.plist
    // legacy layout:  platforms/ios/<AppName>/<AppName>-Info.plist
    return searchDir(iosPlatformRoot, 3);
}

function searchDir(dir, depth) {
    if (depth < 0) {
        return null;
    }

    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        return null;
    }

    for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('-Info.plist')) {
            return path.join(dir, entry.name);
        }
    }

    for (const entry of entries) {
        if (entry.isDirectory() &&
            entry.name !== 'CordovaLib' &&
            entry.name !== 'cordova' &&
            entry.name !== 'Pods') {
            const found = searchDir(path.join(dir, entry.name), depth - 1);
            if (found) {
                return found;
            }
        }
    }

    return null;
}