import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const messageDir = resolve(root, "src/common/messagesJson");
const en = JSON.parse(readFileSync(resolve(messageDir, "en.json"), "utf8"));
const zh = JSON.parse(readFileSync(resolve(messageDir, "zh.json"), "utf8"));
const zhTw = JSON.parse(readFileSync(resolve(messageDir, "zh-tw.json"), "utf8"));
const placeholderRe = /(%\{[^}]+\}|\$\{[^}]+\})/g;
const tokens = (value) => Array.from(String(value).matchAll(placeholderRe), (match) => match[1]).sort();

const allowedFallbackKey = /^(lang-.*|K\.long_p2p_sync|K\.short_p2p_sync|moduleLiveSyncMain\.logPluginVersion|obsidianLiveSyncSettingTab\.linkTroubleshooting|obsidianLiveSyncSettingTab\.(optionCouchDB|optionLiveSync|titleCouchDB)|P2P\.PaneTitle|TweakMismatchResolve\.Table\.Row|Ui\.SetupWizard\.SetupRemote\.CouchDbOption|Ui\.UseSetupURI\.Label|moduleMigration\.docUri|Setup\.QRCode)$/;
const allowedFallbackValue = /^(MB|CouchDB|P2P|S3|MinIO|R2|JWT|IndexedDB|IDB|E2EE|Hatch|Vault|Obsidian|LiveSync|Self-hosted LiveSync|PouchDB|WebRTC|WebSocket|HTTP|HTTPS|Red Flag)$/;

function checkLanguage(lang, messages) {
    const issues = [];
    for (const [key, enValue] of Object.entries(en)) {
        if (!(key in messages)) {
            issues.push(`${lang}: missing key ${key}`);
            continue;
        }
        const value = String(messages[key]);
        if (/[?]{2,}|�/.test(value)) {
            issues.push(`${lang}: damaged value ${key}=${JSON.stringify(value)}`);
        }
        if (
            value === enValue &&
            !allowedFallbackKey.test(key) &&
            !allowedFallbackValue.test(String(enValue))
        ) {
            issues.push(`${lang}: untranslated value ${key}`);
        }
        const expectedTokens = JSON.stringify(tokens(enValue));
        const actualTokens = JSON.stringify(tokens(value));
        if (expectedTokens !== actualTokens) {
            issues.push(`${lang}: placeholder mismatch ${key}: expected ${expectedTokens}, got ${actualTokens}`);
        }
    }
    return issues;
}

const issues = [...checkLanguage("zh", zh), ...checkLanguage("zh-tw", zhTw)];
if (issues.length > 0) {
    console.error(issues.slice(0, 50).join("\n"));
    if (issues.length > 50) {
        console.error(`...and ${issues.length - 50} more issues`);
    }
    process.exit(1);
}

console.log("Chinese UI i18n check passed");
