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
 *
 * Deliberately dependency-free: rather than pulling in a plist-parsing
 * npm package (which needs its own `npm install` step inside the plugin
 * folder — not guaranteed to happen the same way across every install
 * method: local path, git URL, npm registry, CI), this does a targeted
 * text replacement using only Node's built-in `fs`/`path`. That value is
 * fully predictable Apple plist XML, so a regex is enough and this works
 * the instant the plugin is installed, with zero extra steps.
 */

const fs = require('fs');
const path = require('path');

// Matches: <key>UISceneDelegateClassName</key> ... <string>XYZ.SceneDelegate</string>
// Captures the module-name prefix so we can rebuild "<prefix>.AppSceneDelegate".
// Only matches entries still pointing at the default "*.SceneDelegate" class,
// so re-running this hook (or running it after it already patched the file)
// is a no-op instead of double-appending "AppSceneDelegate.AppSceneDelegate".
const SCENE_DELEGATE_PATTERN =
    /(<key>\s*UISceneDelegateClassName\s*<\/key>\s*<string>)([^<]*?)\.SceneDelegate(\s*<\/string>)/g;

module.exports = function (context) {
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

    const original = fs.readFileSync(infoPlistPath, 'utf8');
    let matchCount = 0;

    const patched = original.replace(SCENE_DELEGATE_PATTERN, (full, prefix, moduleName, suffix) => {
        matchCount++;
        return `${prefix}${moduleName}.AppSceneDelegate${suffix}`;
    });

    if (matchCount === 0) {
        console.log(
            '[cordova-plugin-coldstart-ios-fix] No "*.SceneDelegate" entry found in Info.plist ' +
            '(already patched, or an unexpected Info.plist structure) — no changes made.'
        );
        return;
    }

    fs.writeFileSync(infoPlistPath, patched);
    console.log(
        `[cordova-plugin-coldstart-ios-fix] Patched ${matchCount} UISceneDelegateClassName entr${matchCount === 1 ? 'y' : 'ies'} ` +
        `-> AppSceneDelegate in ${infoPlistPath}`
    );
};

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