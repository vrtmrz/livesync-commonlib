/**
# Rosetta stone
- To localise messages to your language, please write a translation to this file and submit a PR.
- Please order languages in alphabetic order, if you write multiple items.

## Notice to ensure that your favours are not wasted.

If you plan to utilise machine translation engines to contribute translated resources,
please ensure the engine's terms of service are compatible with our project's license.
Your diligence in this matter helps maintain compliance and avoid potential licensing issues.
Thank you for your consideration.

Usually, our projects (Obsidian LiveSync and its families) are licensed under MIT License.
To see details, please refer to the LICENSES file on each repository.

## How to internationalise untranslated items?
1. Change the message literal to tagged literal
  "Could not parse YAML" -> $f`Could not parse YAML`
2. Create `ls-debug` folder under the `.obsidian` folder of your vault.
3. Run Self-hosted LiveSync in dev mode (npm run dev).
4. You will get the `missing-translation-YYYY-MM-DD.jsonl` under `ls-debug`. Please copy and paste inside `allMessages` and write the translations.
5. Send me the PR!
*/

const LANG_DE = "de";
const LANG_JA = "ja";
const LANG_RU = "ru";
const LANG_ZH = "zh";
const LANG_ZH_TW = "zh-tw";

// Also please order in alphabetic order.

export const SUPPORTED_I18N_LANGS = [
    LANG_DE,
    LANG_JA,
    LANG_RU,
    LANG_ZH,
    LANG_ZH_TW,
];

// Also this.
export type I18N_LANGS =
    "def" |
    typeof LANG_DE |
    typeof LANG_JA |
    typeof LANG_RU |
    typeof LANG_ZH |
    typeof LANG_ZH_TW |
    "";

type MESSAGE = { [key in I18N_LANGS]?: string };

// Here begins Translation table
export const allMessages: Record<string, MESSAGE> = {
    "Self-hosted LiveSync has undergone a major upgrade. Please open the setting dialog, and check the information pane.": {
        "ja": "Self-hosted LiveSyncにメジャーバージョンアップがありました。設定を開き、Information paneを確認してください"
    },
    "lang-de": { "def": "Deutsche" },
    "lang-ja": { "def": "日本語" },
    "lang-ru": { "def": "Русский" },
    "lang-zh": { "def": "简体中文" },
    "lang-zh-tw": { "def": "繁體中文" },
    "Self-hosted LiveSync": {},
    "Remote Type": {},
    "Remote server type": {},
    "Endpoint URL": {},
    "Access Key": {},
    "Secret Key": {},
    "Region": {},
    "Bucket Name": {},
    "Use Custom HTTP Handler": {},
    "If your Object Storage could not configured accepting CORS, enable this.": {},
    "URI": {},
    "Username": {},
    "username": {},
    "Password": {},
    "password": {},
    "Database name": {},
    "Incubate Chunks in Document": {},
    "If enabled, newly created chunks are temporarily kept within the document, and graduated to become independent chunks once stabilised.": {},
    "Maximum Incubating Chunks": {},
    "The maximum number of chunks that can be incubated within the document. Chunks exceeding this number will immediately graduate to independent chunks.": {},
    "Maximum Incubating Chunk Size": {},
    "The maximum total size of chunks that can be incubated within the document. Chunks exceeding this size will immediately graduate to independent chunks.": {},
    "Maximum Incubation Period": {},
    "The maximum duration for which chunks can be incubated within the document. Chunks exceeding this period will graduate to independent chunks.": {},
    "Data Compression": {},
    "End-to-End Encryption": {},
    "Encrypt contents on the remote database. If you use the plugin's synchronization feature, enabling this is recommend.": {},
    "Passphrase": {},
    "Encrypting passphrase. If you change the passphrase of an existing database, overwriting the remote database is strongly recommended.": {},
    "Path Obfuscation": {},
    "Use dynamic iteration count": {},
    "Display Language": {},
    "Not all messages have been translated. And, please revert to \"Default\" when reporting errors.": {
        ja: "すべてのメッセージが翻訳されているわけではありません。また、Issue報告の際にはいったん\"Default\"に戻してください"
    },
    "Show status inside the editor": {},
    "Reflected after reboot": {},
    "Show status as icons only": {},
    "Show status on the status bar": {},
    "Reflected after reboot.": {},
    "Show only notifications": {},
    "Prevent logging and show only notification": {},
    "Verbose Log": {},
    "Show verbose log": {},
    "Memory cache size (by total items)": {},
    "Memory cache size (by total characters)": {},
    "(Mega chars)": {},
    "Filename": {},
    "If you set this, all settings are saved in a markdown file. You will be notified when new settings arrive. You can set different files by the platform.": {},
    "Write credentials in the file": {},
    "(Not recommended) If set, credentials will be stored in the file.": {},
    "Notify all setting files": {},
    "Encrypting sensitive configuration items": {},
    "Passphrase of sensitive configuration items": {},
    "This passphrase will not be copied to another device. It will be set to `Default` until you configure it again.": {},
    "Presets": {},
    "Apply preset configuration": {},
    "Sync Mode": {},
    "Periodic Sync interval": {},
    "Interval (sec)": {},
    "Sync on Save": {},
    "When you save a file, sync automatically": {},
    "Sync on Editor Save": {},
    "When you save a file in the editor, sync automatically": {},
    "Sync on File Open": {},
    "When you open a file, sync automatically": {},
    "Sync on Start": {},
    "Start synchronization after launching Obsidian.": {},
    "Sync after merging file": {},
    "Sync automatically after merging files": {},
    "Use the trash bin": {},
    "Do not delete files that are deleted in remote, just move to trash.": {},
    "Keep empty folder": {},
    "Normally, a folder is deleted when it becomes empty after a synchronization. Enabling this will prevent it from getting deleted": {},
    "Always overwrite with a newer file (beta)": {},
    "(Def off) Resolve conflicts by newer files automatically.": {},
    "Postpone resolution of inactive files": {},
    "Postpone manual resolution of inactive files": {},
    "Always resolve conflicts manually": {},
    "If this switch is turned on, a merge dialog will be displayed, even if the sensible-merge is possible automatically. (Turn on to previous behavior)": {},
    "Always reflect synchronized changes even if the note has a conflict": {},
    "Turn on to previous behavior": {},
    "Scan for hidden files before replication": {},
    "Scan hidden files periodically": {},
    "Seconds, 0 to disable": {},
    "Batch database update": {},
    "Reducing the frequency with which on-disk changes are reflected into the DB": {},
    "Enhance chunk size": {},
    "Fetch chunks on demand": {},
    "(ex. Read chunks online) If this option is enabled, LiveSync reads chunks online directly instead of replicating them locally. Increasing Custom chunk size is recommended.": {},
    "Maximum file size": {},
    "(MB) If this is set, changes to local and remote files that are larger than this will be skipped. If the file becomes smaller again, a newer one will be used.": {},
    "(Beta) Use ignore files": {},
    "If this is set, changes to local files which are matched by the ignore files will be skipped. Remote changes are determined using local ignore files.": {},
    "Ignore files": {},
    "We can use multiple ignore files, e.g.) `.gitignore, .dockerignore`": {},
    "Batch size": {},
    "Number of change feed items to process at a time. Defaults to 50. Minimum is 2.": {},
    "Batch limit": {},
    "Number of batches to process at a time. Defaults to 40. Minimum is 2. This along with batch size controls how many docs are kept in memory at a time.": {},
    "Use timeouts instead of heartbeats": {},
    "If this option is enabled, PouchDB will hold the connection open for 60 seconds, and if no change arrives in that time, close and reopen the socket, instead of holding it open indefinitely. Useful when a proxy limits request duration but can increase resource usage.": {},
    "Batch size of on-demand fetching": {},
    "The delay for consecutive on-demand fetches": {},
    "Suspend file watching": {},
    "Stop watching for file change.": {},
    "Suspend database reflecting": {},
    "Stop reflecting database changes to storage files.": {},
    "Write logs into the file": {},
    "Warning! This will have a serious impact on performance. And the logs will not be synchronised under the default name. Please be careful with logs; they often contain your confidential information.": {},
    "Do not keep metadata of deleted files.": {},
    "Delete old metadata of deleted files on start-up": {},
    "(Days passed, 0 to disable automatic-deletion)": {},
    "Use an old adapter for compatibility": {},
    "Before v0.17.16, we used an old adapter for the local database. Now the new adapter is preferred. However, it needs local database rebuilding. Please disable this toggle when you have enough time. If leave it enabled, also while fetching from the remote database, you will be asked to disable this.": {},
    "Scan changes on customization sync": {},
    "Do not use internal API": {},
    "Database suffix": {},
    "LiveSync could not handle multiple vaults which have same name without different prefix, This should be automatically configured.": {},
    "The Hash algorithm for chunk IDs": {},
    "Fetch database with previous behaviour": {},
    "Do not check configuration mismatch before replication": {},
    "Device name": {},
    "Unique name between all synchronized devices. To edit this setting, please disable customization sync once.": {},
    "Enable customization sync": {},
    "Scan customization automatically": {},
    "Scan customization before replicating.": {},
    "Scan customization periodically": {},
    "Scan customization every 1 minute.": {},
    "Notify customized": {},
    "Notify when other device has newly customized.": {},
    "Waiting for ready...": {},

}
