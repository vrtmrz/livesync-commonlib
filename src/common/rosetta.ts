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
        "ja": "Self-hosted LiveSyncにメジャーバージョンアップがありました。設定を開き、Information paneを確認してください",
        zh: "Self-hosted LiveSync 已经进行了重大升级。请打开设置对话框，检查信息面板。",
    },
    "lang-de": { "def": "Deutsche" },
    "lang-ja": { "def": "日本語" },
    "lang-ru": { "def": "Русский" },
    "lang-zh": { "def": "简体中文" },
    "lang-zh-tw": { "def": "繁體中文" },
    "Self-hosted LiveSync": {
        zh: "自托管 LiveSync",
    },
    "Remote Type": {
        zh: "远程类型",
    },
    "Remote server type": {
        zh: "远程服务器类型",
    },
    "Endpoint URL": {
        zh: "终端节点网址",
    },
    "Access Key": {
        zh: "访问密钥ID",
    },
    "Secret Key": {
        zh: "访问密钥密码",
    },
    "Region": {
        zh: "地域",
    },
    "Bucket Name": {
        zh: "存储桶名称",
    },
    "Use Custom HTTP Handler": {
        zh: "使用自定义HTTP处理程序",
    },
    "If your Object Storage could not configured accepting CORS, enable this.": {
        zh: "如果您的对象存储无法配置接受CORS，请启用此功能。",
    },
    "URI": {
        zh: "URI",
    },
    "Username": {
        zh: "用户名",
    },
    "username": {
        zh: "用户名",
    },
    "Password": {
        zh: "密码",
    },
    "password": {
        zh: "密码",
    },
    "Database name": {
        zh: "数据库名称",
    },
    "Incubate Chunks in Document": {
        zh: "在文档中孵化块",
    },
    "If enabled, newly created chunks are temporarily kept within the document, and graduated to become independent chunks once stabilised.": {
        zh: "如果启用，新创建的数据块将暂时保留在文档中，并在稳定后成为独立数据块。",
    },
    "Maximum Incubating Chunks": {
        zh: "最大孵化块数",
    },
    "The maximum number of chunks that can be incubated within the document. Chunks exceeding this number will immediately graduate to independent chunks.": {
        zh: "文档中可以孵化的数据块的最大数量。超过此数量的数据块将立即成为独立数据块。",
    },
    "Maximum Incubating Chunk Size": {
        zh: "最大孵化块大小",
    },
    "The maximum total size of chunks that can be incubated within the document. Chunks exceeding this size will immediately graduate to independent chunks.": {
        zh: "文档中可以孵化的数据块的最大尺寸。超过此大小的数据块将立即成为独立数据块。",
    },
    "Maximum Incubation Period": {
        zh: "最大孵化期限",
    },
    "The maximum duration for which chunks can be incubated within the document. Chunks exceeding this period will graduate to independent chunks.": {
        zh: "文档中可以孵化的数据块的最大持续时间。超过此时间的数据块将成为独立数据块。",
    },
    "Data Compression": {
        zh: "数据压缩",
    },
    "End-to-End Encryption": {
        zh: "端到端加密",
    },
    "Encrypt contents on the remote database. If you use the plugin's synchronization feature, enabling this is recommended.": {
        zh: "加密远程数据库中的内容。如果您使用插件的同步功能，则建议启用此功能。",
    },
    "Passphrase": {
        zh: "口令",
    },
    "Encrypting passphrase. If you change the passphrase of an existing database, overwriting the remote database is strongly recommended.": {
        zh: "加密口令。如果更改现有数据库的口令，则强烈建议覆盖远程数据库。",
    },
    "Path Obfuscation": {
        zh: "路径混淆",
    },
    "Use dynamic iteration count": {
        zh: "使用动态迭代次数",
    },
    "Display Language": {
        zh: "显示语言",
    },
    "Not all messages have been translated. And, please revert to \"Default\" when reporting errors.": {
        ja: "すべてのメッセージが翻訳されているわけではありません。また、Issue報告の際にはいったん\"Default\"に戻してください",
        zh: "并非所有消息都已翻译。请在报告错误时恢复为\"Default\"",
    },
    "Show status inside the editor": {
        zh: "在编辑器内显示状态",
    },
    "Reflected after reboot": {
        zh: "重启后生效",
    },
    "Show status as icons only": {
        zh: "仅以图标显示状态",
    },
    "Show status on the status bar": {
        zh: "在状态栏上显示状态",
    },
    "Reflected after reboot.": {
        zh: "重启后生效",
    },
    "Show only notifications": {
        zh: "仅显示通知",
    },
    "Prevent logging and show only notification": {
        zh: "阻止记录日志并仅显示通知",
    },
    "Verbose Log": {
        zh: "详细日志",
    },
    "Show verbose log": {
        zh: "显示详细日志",
    },
    "Memory cache size (by total items)": {
        zh: "内存缓存大小（按总项目数）",
    },
    "Memory cache size (by total characters)": {
        zh: "内存缓存大小（按总字符数）",
    },
    "(Mega chars)": {
        zh: "（百万字符）",
    },
    "Filename": {
        zh: "文件名",
    },
    "If you set this, all settings are saved in a markdown file. You will be notified when new settings arrive. You can set different files by the platform.": {
        zh: "如果设置了此项，所有设置都将保存在一个Markdown文件中。当新设置到达时，您将收到通知。您可以根据平台设置不同的文件。",
    },
    "Write credentials in the file": {
        zh: "将凭据写入文件",
    },
    "(Not recommended) If set, credentials will be stored in the file.": {
        zh: "（不建议）如果设置，凭据将存储在文件中。",
    },
    "Notify all setting files": {
        zh: "通知所有设置文件",
    },
    "Encrypting sensitive configuration items": {
        zh: "加密敏感配置项",
    },
    "Passphrase of sensitive configuration items": {
        zh: "敏感配置项的口令",
    },
    "This passphrase will not be copied to another device. It will be set to `Default` until you configure it again.": {
        zh: "此口令不会复制到另一台设备。在您再次配置之前，它将设置为`Default`。",
    },
    "Presets": {
        zh: "预设",
    },
    "Apply preset configuration": {
        zh: "应用预设配置",
    },
    "Sync Mode": {
        zh: "同步模式",
    },
    "Periodic Sync interval": {
        zh: "定期同步间隔",
    },
    "Interval (sec)": {
        zh: "间隔（秒）",
    },
    "Sync on Save": {
        zh: "保存时同步",
    },
    "When you save a file, sync automatically": {
        zh: "保存文件时，自动同步",
    },
    "Sync on Editor Save": {
        zh: "编辑器保存时同步",
    },
    "When you save a file in the editor, sync automatically": {
        zh: "在编辑器中保存文件时，自动同步",
    },
    "Sync on File Open": {
        zh: "打开文件时同步",
    },
    "When you open a file, sync automatically": {
        zh: "打开文件时，自动同步",
    },
    "Sync on Start": {
        zh: "启动时同步",
    },
    "Start synchronization after launching Obsidian.": {
        zh: "启动Obsidian后开始同步",
    },
    "Sync after merging file": {
        zh: "合并文件后同步",
    },
    "Sync automatically after merging files": {
        zh: "合并文件后自动同步",
    },
    "Use the trash bin": {
        zh: "使用回收站",
    },
    "Do not delete files that are deleted in remote, just move to trash.": {
        zh: "不删除被远程删除的文件，只是移动到回收站",
    },
    "Keep empty folder": {
        zh: "保留空文件夹",
    },
    "Normally, a folder is deleted when it becomes empty after a synchronization. Enabling this will prevent it from getting deleted": {
        zh: "通常，同步后，文件夹变为空时会被删除。启用此功能将阻止其被删除",
    },
    "Always overwrite with a newer file (beta)": {
        zh: "始终使用更新的文件覆盖（测试版）",
    },
    "(Def off) Resolve conflicts by newer files automatically.": {
        zh: "（默认关闭）自动使用更新的文件解决冲突",
    },
    "Postpone resolution of inactive files": {
        zh: "推迟解决不活动文件",
    },
    "Postpone manual resolution of inactive files": {
        zh: "推迟手动解决不活动文件",
    },
    "Always resolve conflicts manually": {
        zh: "始终手动解决冲突",
    },
    "If this switch is turned on, a merge dialog will be displayed, even if the sensible-merge is possible automatically. (Turn on to previous behavior)": {
        zh: "如果打开此开关，即使可以自动进行合并，也会显示合并对话框。（打开可恢复到以前的行为）",
    },
    "Always reflect synchronized changes even if the note has a conflict": {
        zh: "即使笔记存在冲突，也始终反映同步的更改",
    },
    "Turn on to previous behavior": {
        zh: "打开可恢复到以前的行为",
    },
    "Scan for hidden files before replication": {
        zh: "复制前扫描隐藏文件",
    },
    "Scan hidden files periodically": {
        zh: "定期扫描隐藏文件",
    },
    "Seconds, 0 to disable": {
        zh: "秒，0为禁用",
    },
    "Batch database update": {
        zh: "批量数据库更新",
    },
    "Reducing the frequency with which on-disk changes are reflected into the DB": {
        zh: "降低将磁盘上的更改反映到数据库中的频率",
    },
    "Enhance chunk size": {
        zh: "增强块大小",
    },
    "Fetch chunks on demand": {
        zh: "按需获取块",
    },
    "(ex. Read chunks online) If this option is enabled, LiveSync reads chunks online directly instead of replicating them locally. Increasing Custom chunk size is recommended.": {
        zh: "（例如，在线读取块）如果启用此选项，LiveSync将直接在线读取块，而不是在本地复制块。建议增加自定义块大小",
    },
    "Maximum file size": {
        zh: "最大文件大小",
    },
    "(MB) If this is set, changes to local and remote files that are larger than this will be skipped. If the file becomes smaller again, a newer one will be used.": {
        zh: "（MB）如果设置了此项，大于此大小的本地和远程文件的更改将被跳过。如果文件再次变小，将使用更新的文件",
    },
    "(Beta) Use ignore files": {
        zh: "（测试版）使用忽略文件",
    },
    "If this is set, changes to local files which are matched by the ignore files will be skipped. Remote changes are determined using local ignore files.": {
        zh: "如果设置了此项，与忽略文件匹配的本地文件的更改将被跳过。远程更改使用本地忽略文件确定",
    },
    "Ignore files": {
        zh: "忽略文件",
    },
    "We can use multiple ignore files, e.g.) `.gitignore, .dockerignore`": {
        zh: "我们可以使用多个忽略文件，例如`.gitignore, .dockerignore`",
    },
    "Batch size": {
        zh: "批量大小",
    },
    "Number of change feed items to process at a time. Defaults to 50. Minimum is 2.": {
        zh: "一次处理的更改源项目数。默认为50。最小为2",
    },
    "Batch limit": {
        zh: "批量限制",
    },
    "Number of batches to process at a time. Defaults to 40. Minimum is 2. This along with batch size controls how many docs are kept in memory at a time.": {
        zh: "一次处理的批量数。默认为40。最小为2。这与批量大小一起控制一次在内存中保留多少文档",
    },
    "Use timeouts instead of heartbeats": {
        zh: "使用超时而不是心跳",
    },
    "If this option is enabled, PouchDB will hold the connection open for 60 seconds, and if no change arrives in that time, close and reopen the socket, instead of holding it open indefinitely. Useful when a proxy limits request duration but can increase resource usage.": {
        zh: "如果启用此选项，PouchDB将保持连接打开60秒，如果在此时间内没有更改到达，则关闭并重新打开套接字，而不是无限期保持打开。当代理限制请求持续时间时有用，但可能会增加资源使用",
    },
    "Batch size of on-demand fetching": {
        zh: "按需获取的批量大小",
    },
    "The delay for consecutive on-demand fetches": {
        zh: "连续按需获取的延迟",
    },
    "Suspend file watching": {
        zh: "暂停文件监视",
    },
    "Stop watching for file change.": {
        zh: "停止监视文件更改",
    },
    "Suspend database reflecting": {
        zh: "暂停数据库反映",
    },
    "Stop reflecting database changes to storage files.": {
        zh: "停止将数据库更改反映到存储文件",
    },
    "Write logs into the file": {
        zh: "将日志写入文件",
    },
    "Warning! This will have a serious impact on performance. And the logs will not be synchronised under the default name. Please be careful with logs; they often contain your confidential information.": {
        zh: "警告！这将严重影响性能。并且日志不会以默认名称同步。请小心处理日志；它们通常包含您的敏感信息",
    },
    "Do not keep metadata of deleted files.": {
        zh: "不保留已删除文件的元数据",
    },
    "Delete old metadata of deleted files on start-up": {
        zh: "启动时删除已删除文件的旧元数据",
    },
    "(Days passed, 0 to disable automatic-deletion)": {
        zh: "（天数，0为禁用自动删除）",
    },
    "Use an old adapter for compatibility": {
        zh: "为了兼容性使用旧适配器",
    },
    "Before v0.17.16, we used an old adapter for the local database. Now the new adapter is preferred. However, it needs local database rebuilding. Please disable this toggle when you have enough time. If leave it enabled, also while fetching from the remote database, you will be asked to disable this.": {
        zh: "在v0.17.16之前，我们使用了旧适配器作为本地数据库。现在更倾向于使用新适配器。但是，它需要重建本地数据库。请在有足够时间时禁用此切换。如果保留启用状态，且在从远程数据库获取时，将要求您禁用此切换",
    },
    "Scan changes on customization sync": {
        zh: "在自定义同步时扫描更改",
    },
    "Do not use internal API": {
        zh: "不使用内部API",
    },
    "Database suffix": {
        zh: "数据库后缀",
    },
    "LiveSync could not handle multiple vaults which have same name without different prefix, This should be automatically configured.": {
        zh: "LiveSync无法处理具有相同名称但没有不同前缀的多个仓库。这应该自动配置",
    },
    "The Hash algorithm for chunk IDs": {
        zh: "块ID的哈希算法",
    },
    "Fetch database with previous behaviour": {
        zh: "用以前的行为获取数据库",
    },
    "Do not check configuration mismatch before replication": {
        zh: "在复制前不检查配置不匹配",
    },
    "Device name": {
        zh: "设备名称",
    },
    "Unique name between all synchronized devices. To edit this setting, please disable customization sync once.": {
        zh: "所有同步设备之间的唯一名称。要编辑此设置，请首先禁用自定义同步",
    },
    "Enable customization sync": {
        zh: "启用自定义同步",
    },
    "Scan customization automatically": {
        zh: "自动扫描自定义设置",
    },
    "Scan customization before replicating.": {
        zh: "在复制前扫描自定义设置",
    },
    "Scan customization periodically": {
        zh: "定期扫描自定义设置",
    },
    "Scan customization every 1 minute.": {
        zh: "每1分钟扫描自定义设置",
    },
    "Notify customized": {
        zh: "通知自定义设置",
    },
    "Notify when other device has newly customized.": {
        zh: "当其他设备有新的自定义设置时通知",
    },
    "Waiting for ready...": {
        zh: "等待就绪...",
    },

}
