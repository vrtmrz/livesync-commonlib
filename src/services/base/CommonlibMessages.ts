/**
 * Canonical English messages owned by Commonlib.
 *
 * Hosts may optionally translate these keys. When they do not, Commonlib uses
 * these messages so that symbolic keys are never exposed to users.
 */
export const commonlibEnglishMessages = {
    "(BETA) Always overwrite with a newer file": "(BETA) Always overwrite with a newer file",
    "(Beta) Use ignore files": "(Beta) Use ignore files",
    "(Days passed, 0 to disable automatic-deletion)": "(Days passed, 0 to disable automatic-deletion)",
    "(MB) If this is set, changes to local and remote files that are larger than this will be skipped. If the file becomes smaller again, a newer one will be used.":
        "(MB) If this is set, changes to local and remote files that are larger than this will be skipped. If the file becomes smaller again, a newer one will be used.",
    "(Mega chars)": "(Mega chars)",
    "(Not recommended) If set, credentials will be stored in the file.":
        "(Not recommended) If set, credentials will be stored in the file.",
    "(Obsolete) Use an old adapter for compatibility": "(Obsolete) Use an old adapter for compatibility",
    "(ex. Read chunks online) If this option is enabled, LiveSync reads chunks online directly instead of replicating them locally. Increasing Custom chunk size is recommended.":
        "(ex. Read chunks online) If this option is enabled, LiveSync reads chunks online directly instead of replicating them locally. Increasing Custom chunk size is recommended.",
    "Access Key": "Access Key",
    "Active Remote Type": "Active Remote Type",
    "Always prompt merge conflicts": "Always prompt merge conflicts",
    "Application ID": "Application ID",
    "Apply Latest Change if Conflicting": "Apply Latest Change if Conflicting",
    "Apply preset configuration": "Apply preset configuration",
    "Auto-accept compatible tweak mismatches": "Auto-accept compatible tweak mismatches",
    "Automatically Sync all files when opening Obsidian.": "Automatically Sync all files when opening Obsidian.",
    "Automatically accepts mismatches that are compatible but potentially lossy by comparing tweak modification times.":
        "Automatically accepts mismatches that are compatible but potentially lossy by comparing tweak modification times.",
    "Automatically broadcast changes to connected peers": "Automatically broadcast changes to connected peers",
    "Automatically start P2P connection on launch": "Automatically start P2P connection on launch",
    "Batch database update": "Batch database update",
    "Batch limit": "Batch limit",
    "Batch size": "Batch size",
    "Batch size of on-demand fetching": "Batch size of on-demand fetching",
    "Before v0.17.16, we used an old adapter for the local database. Now the new adapter is preferred. However, it needs local database rebuilding. Please disable this toggle when you have enough time. If leave it enabled, also while fetching from the remote database, you will be asked to disable this.":
        "Before v0.17.16, we used an old adapter for the local database. Now the new adapter is preferred. However, it needs local database rebuilding. Please disable this toggle when you have enough time. If leave it enabled, also while fetching from the remote database, you will be asked to disable this.",
    "Bucket Name": "Bucket Name",
    "Chunk Splitter": "Chunk Splitter",
    "Chunk revisions are always derived from their content. This stored key is retained only for compatibility.":
        "Chunk revisions are always derived from their content. This stored key is retained only for compatibility.",
    "Comma separated `.gitignore, .dockerignore`": "Comma separated `.gitignore, .dockerignore`",
    "Content-derived chunk revisions (obsolete setting)": "Content-derived chunk revisions (obsolete setting)",
    "Custom Headers": "Custom Headers",
    "Custom headers for requesting the CouchDB. e.g. `x-custom-header1: value1\n x-custom-header2: value2`":
        "Custom headers for requesting the CouchDB. e.g. `x-custom-header1: value1\n x-custom-header2: value2`",
    "Custom headers for requesting the bucket. e.g. `x-custom-header1: value1\n x-custom-header2: value2`":
        "Custom headers for requesting the bucket. e.g. `x-custom-header1: value1\n x-custom-header2: value2`",
    "Data Compression": "Data Compression",
    "Database Name": "Database Name",
    "Database suffix": "Database suffix",
    "Delay conflict resolution of inactive files": "Delay conflict resolution of inactive files",
    "Delay merge conflict prompt for inactive files.": "Delay merge conflict prompt for inactive files.",
    "Delete old metadata of deleted files on start-up": "Delete old metadata of deleted files on start-up",
    "Desktop only; uses more battery and network.": "Desktop only; uses more battery and network.",
    "Device name": "Device name",
    "Disables logging, only shows notifications. Please disable if you report an issue.":
        "Disables logging, only shows notifications. Please disable if you report an issue.",
    "Display Language": "Display Language",
    "Do not check configuration mismatch before replication": "Do not check configuration mismatch before replication",
    "Do not keep metadata of deleted files.": "Do not keep metadata of deleted files.",
    "Do not split chunks in the background": "Do not split chunks in the background",
    "Do not use internal API": "Do not use internal API",
    "Doctor.Button.DismissThisVersion": "No, and do not ask again until the next release",
    "Doctor.Button.Fix": "Fix it",
    "Doctor.Button.FixButNoRebuild": "Fix it but no rebuild",
    "Doctor.Button.No": "No",
    "Doctor.Button.Skip": "Leave it as is",
    "Doctor.Button.Yes": "Yes",
    "Doctor.Dialogue.Main":
        "Hi! Config Doctor has been activated because of ${activateReason}!\nAnd, unfortunately some configurations were detected as potential problems.\nPlease be assured. Let's solve them one by one.\n\nTo let you know ahead of time, we will ask you about the following items.\n\n${issues}\n\nShall we get started?",
    "Doctor.Dialogue.MainFix":
        "\n## ${name}\n\n| Current | Ideal |\n|:---:|:---:|\n| ${current} | ${ideal} |\n\n**Recommendation Level:** ${level}\n\n### Why this has been detected?\n\n${reason}\n\n${note}\n\nFix this to the ideal value?",
    "Doctor.Dialogue.Title": "Self-hosted LiveSync Config Doctor",
    "Doctor.Dialogue.TitleAlmostDone": "Almost done!",
    "Doctor.Dialogue.TitleFix": "Fix issue ${current}/${total}",
    "Doctor.Level.Must": "Must",
    "Doctor.Level.Necessary": "Necessary",
    "Doctor.Level.Optional": "Optional",
    "Doctor.Level.Recommended": "Recommended",
    "Doctor.Message.NoIssues": "No issues detected!",
    "Doctor.Message.RebuildLocalRequired": "Attention! A local database rebuild is required to apply this!",
    "Doctor.Message.RebuildRequired": "Attention! A rebuild is required to apply this!",
    "Doctor.Message.SomeSkipped": "We left some issues as is. Shall I ask you again on next startup?",
    "Doctor.RULES.E2EE_V02500.REASON":
        "The End-to-End Encryption has got now more robust and faster. Also because, the previous E2EE was found to be compromised in a re-conducted code review. It should be applied as soon as possible. Really apologises for your inconvenience. And, this setting is not forward compatible. All synchronised devices must be updated to v0.25.0 or higher. Rebuilds are not required and will be converted from the new transfer to the new format, However, it is recommended to rebuild whenever possible.",
    "Effectively a directory. Should end with `/`. e.g., `vault-name/`.":
        "Effectively a directory. Should end with `/`. e.g., `vault-name/`.",
    "Enable Developers' Debug Tools (If available).": "Enable Developers' Debug Tools (If available).",
    "Enable P2P Synchronization": "Enable P2P Synchronization",
    "Enable advanced features": "Enable advanced features",
    "Enable customization sync": "Enable customization sync",
    "Enable edge case treatment features": "Enable edge case treatment features",
    "Enable forcePathStyle": "Enable forcePathStyle",
    "Enable per-file customization sync": "Enable per-file customization sync",
    "Enable poweruser features": "Enable poweruser features",
    "Enable this if your Object Storage doesn't support CORS":
        "Enable this if your Object Storage doesn't support CORS",
    "Enable this option to automatically apply the most recent change to documents even when it conflicts":
        "Enable this option to automatically apply the most recent change to documents even when it conflicts",
    "Encrypt contents on the remote database. If you use the plugin's synchronization feature, enabling this is recommended.":
        "Encrypt contents on the remote database. If you use the plugin's synchronization feature, enabling this is recommended.",
    "Encrypting sensitive configuration items": "Encrypting sensitive configuration items",
    "Encryption passphrase. If changed, you should overwrite the server's database with the new (encrypted) files.":
        "Encryption passphrase. If changed, you should overwrite the server's database with the new (encrypted) files.",
    "End-to-End Encryption": "End-to-End Encryption",
    "End-to-End Encryption Algorithm": "End-to-End Encryption Algorithm",
    "Endpoint URL": "Endpoint URL",
    "Enhance chunk size": "Enhance chunk size",
    "Fetch chunks on demand": "Fetch chunks on demand",
    "Fetch database with previous behaviour": "Fetch database with previous behaviour",
    "File prefix on the bucket": "File prefix on the bucket",
    Filename: "Filename",
    "Files with modification times greater than this value (in seconds since the Unix epoch) will not have their events reflected. Set to 0 to disable this limit.":
        "Files with modification times greater than this value (in seconds since the Unix epoch) will not have their events reflected. Set to 0 to disable this limit.",
    "Forces the file to be synced when opened.": "Forces the file to be synced when opened.",
    "Handle files as Case-Sensitive": "Handle files as Case-Sensitive",
    "How to display network errors when the sync server is unreachable.":
        "How to display network errors when the sync server is unreachable.",
    "If disabled(toggled), chunks will be split on the UI thread (Previous behaviour).":
        "If disabled(toggled), chunks will be split on the UI thread (Previous behaviour).",
    "If enabled per-filed efficient customization sync will be used. We need a small migration when enabling this. And all devices should be updated to v0.23.18. Once we enabled this, we lost a compatibility with old versions.":
        "If enabled per-filed efficient customization sync will be used. We need a small migration when enabling this. And all devices should be updated to v0.23.18. Once we enabled this, we lost a compatibility with old versions.",
    "If enabled, changes will be automatically broadcasted to all connected peers. Notified peers will start fetching the changes.":
        "If enabled, changes will be automatically broadcasted to all connected peers. Notified peers will start fetching the changes.",
    "If enabled, chunks will be split into no more than 100 items. However, dedupe is slightly weaker.":
        "If enabled, chunks will be split into no more than 100 items. However, dedupe is slightly weaker.",
    "If enabled, efficient per-file customization sync will be used. A minor migration is required when enabling this feature, and all devices must be updated to v0.23.18. Enabling this feature will result in losing compatibility with older versions.":
        "If enabled, efficient per-file customization sync will be used. A minor migration is required when enabling this feature, and all devices must be updated to v0.23.18. Enabling this feature will result in losing compatibility with older versions.",
    "If enabled, newly created chunks are temporarily kept within the document, and graduated to become independent chunks once stabilised.":
        "If enabled, newly created chunks are temporarily kept within the document, and graduated to become independent chunks once stabilised.",
    "If enabled, the P2P connection will be automatically started when the application launches.":
        "If enabled, the P2P connection will be automatically started when the application launches.",
    "If enabled, the file properties will be encrypted in the remote database. This is useful for protecting sensitive information in file paths, sizes, and IDs of its chunks. If you are using V1 E2EE, this only obfuscates the file path.":
        "If enabled, the file properties will be encrypted in the remote database. This is useful for protecting sensitive information in file paths, sizes, and IDs of its chunks. If you are using V1 E2EE, this only obfuscates the file path.",
    "If enabled, the file under 1kb will be processed in the UI thread.":
        "If enabled, the file under 1kb will be processed in the UI thread.",
    "If enabled, the forcePathStyle option will be used for bucket operations.":
        "If enabled, the forcePathStyle option will be used for bucket operations.",
    "If enabled, the notification of hidden files change will be suppressed.":
        "If enabled, the notification of hidden files change will be suppressed.",
    "If enabled, the plugin will not attempt to connect to the remote database even if the chunk was not found locally.":
        "If enabled, the plugin will not attempt to connect to the remote database even if the chunk was not found locally.",
    "If enabled, the request API will be used to avoid `inevitable` CORS problems. This is a workaround and may not work in all cases. PLEASE READ THE DOCUMENTATION BEFORE USING THIS OPTION. This is a less-secure option.":
        "If enabled, the request API will be used to avoid `inevitable` CORS problems. This is a workaround and may not work in all cases. PLEASE READ THE DOCUMENTATION BEFORE USING THIS OPTION. This is a less-secure option.",
    "If enabled, the ⛔ icon will be shown inside the status instead of the file warnings banner. No details will be shown.":
        "If enabled, the ⛔ icon will be shown inside the status instead of the file warnings banner. No details will be shown.",
    "If this enabled, All files are handled as case-Sensitive (Previous behaviour).":
        "If this enabled, All files are handled as case-Sensitive (Previous behaviour).",
    "If this enabled, JWT will be used for authentication.": "If this enabled, JWT will be used for authentication.",
    "If this enabled, chunks will be split into semantically meaningful segments. Not all platforms support this feature.":
        "If this enabled, chunks will be split into semantically meaningful segments. Not all platforms support this feature.",
    "If this is set, changes to local files which are matched by the ignore files will be skipped. Remote changes are determined using local ignore files.":
        "If this is set, changes to local files which are matched by the ignore files will be skipped. Remote changes are determined using local ignore files.",
    "If this option is enabled, PouchDB will hold the connection open for 60 seconds, and if no change arrives in that time, close and reopen the socket, instead of holding it open indefinitely. Useful when a proxy limits request duration but can increase resource usage.":
        "If this option is enabled, PouchDB will hold the connection open for 60 seconds, and if no change arrives in that time, close and reopen the socket, instead of holding it open indefinitely. Useful when a proxy limits request duration but can increase resource usage.",
    "Ignore files": "Ignore files",
    "Incubate Chunks in Document": "Incubate Chunks in Document",
    "Internal timestamp for resolving compatible tweak mismatches.":
        "Internal timestamp for resolving compatible tweak mismatches.",
    "Interval (sec)": "Interval (sec)",
    "JWT Algorithm": "JWT Algorithm",
    "K.long_p2p_sync": "%{title_p2p_sync}",
    "K.title_p2p_sync": "Peer-to-Peer Sync",
    "Keep empty folder": "Keep empty folder",
    "Keep replication active in the background": "Keep replication active in the background",
    "Key ID": "Key ID",
    "Keypair or pre-shared key": "Keypair or pre-shared key",
    "Last tweak modified timestamp": "Last tweak modified timestamp",
    "LiveSync could not handle multiple vaults which have same name without different prefix, This should be automatically configured.":
        "LiveSync could not handle multiple vaults which have same name without different prefix, This should be automatically configured.",
    "Longest chunk line threshold value (Not Configurable from the UI Now).":
        "Longest chunk line threshold value (Not Configurable from the UI Now).",
    "MB (0 to disable).": "MB (0 to disable).",
    "MB per request": "MB per request",
    "Maximum Incubating Chunk Size": "Maximum Incubating Chunk Size",
    "Maximum Incubating Chunks": "Maximum Incubating Chunks",
    "Maximum Incubation Period": "Maximum Incubation Period",
    "Maximum delay for batch database updating": "Maximum delay for batch database updating",
    "Maximum file modification time for reflected file events":
        "Maximum file modification time for reflected file events",
    "Maximum file size": "Maximum file size",
    "Maximum request size for manually resending chunks": "Maximum request size for manually resending chunks",
    "Memory cache size (by total characters)": "Memory cache size (by total characters)",
    "Memory cache size (by total items)": "Memory cache size (by total items)",
    "Minimum Chunk Size (Not Configurable from the UI Now).": "Minimum Chunk Size (Not Configurable from the UI Now).",
    "Minimum delay for batch database updating": "Minimum delay for batch database updating",
    "Minimum interval for syncing": "Minimum interval for syncing",
    "Move remotely deleted files to the trash, instead of deleting. (This setting is ineffective from Obsidian v1.7.2 onwards, as deletion always respects your Obsidian preferences.)":
        "Move remotely deleted files to the trash, instead of deleting. (This setting is ineffective from Obsidian v1.7.2 onwards, as deletion always respects your Obsidian preferences.)",
    "Network warning style": "Network warning style",
    'Not all messages have been translated. And, please revert to "Default" when reporting errors.':
        'Not all messages have been translated. And, please revert to "Default" when reporting errors.',
    "Notify all setting files": "Notify all setting files",
    "Notify customized": "Notify customized",
    "Notify when other device has newly customized.": "Notify when other device has newly customized.",
    "Notify when the estimated remote storage size exceeds on start up":
        "Notify when the estimated remote storage size exceeds on start up",
    "Now we can choose how to split the chunks; V3 is the most efficient. If you have troubled, please make this Default or Legacy.":
        "Now we can choose how to split the chunks; V3 is the most efficient. If you have troubled, please make this Default or Legacy.",
    "Number of batches to process at a time. Defaults to 40. Minimum is 2. This along with batch size controls how many docs are kept in memory at a time.":
        "Number of batches to process at a time. Defaults to 40. Minimum is 2. This along with batch size controls how many docs are kept in memory at a time.",
    "Number of changes to sync at a time. Defaults to 50. Minimum is 2.":
        "Number of changes to sync at a time. Defaults to 50. Minimum is 2.",
    "P2P.AskPassphraseForDecrypt":
        "The remote peer shared the configuration. Please input the passphrase to decrypt the configuration.",
    "P2P.AskPassphraseForShare":
        "The remote peer requested this device configuration. Please input the passphrase to share the configuration. You can ignore the request by cancelling this dialogue.",
    "P2P.DisabledButNeed": "%{title_p2p_sync} is disabled. Do you really want to enable it?",
    "P2P.NoAutoSyncPeers": "No auto-sync peers found. Please set peers on the %{long_p2p_sync} pane.",
    "P2P.NoKnownPeers": "No peers has been detected, waiting incoming other peers...",
    "P2P.NotEnabled": "%{title_p2p_sync} is not enabled. We cannot open a new connection.",
    "P2P.ReplicatorInstanceMissing": "P2P Sync replicator is not found, possibly not have been configured or enabled.",
    "P2P.SeemsOffline": "Peer ${name} seems offline, skipped.",
    "P2P.SyncAlreadyRunning": "P2P Sync is already running.",
    "P2P.SyncCompleted": "P2P Sync completed.",
    "P2P.SyncStartedWith": "P2P Sync with ${name} have been started.",
    Passphrase: "Passphrase",
    "Passphrase of sensitive configuration items": "Passphrase of sensitive configuration items",
    Password: "Password",
    "Per-file-saved customization sync": "Per-file-saved customization sync",
    "Periodic Sync interval": "Periodic Sync interval",
    "Please select 'Cancel' explicitly to cancel this operation.":
        "Please select 'Cancel' explicitly to cancel this operation.",
    "Please use V2, V1 is deprecated and will be removed in the future, It was not a very appropriate algorithm. Only for compatibility V1 is kept.":
        "Please use V2, V1 is deprecated and will be removed in the future, It was not a very appropriate algorithm. Only for compatibility V1 is kept.",
    Presets: "Presets",
    "Process files even if seems to be corrupted": "Process files even if seems to be corrupted",
    "Process small files in the foreground": "Process small files in the foreground",
    "Property Encryption": "Property Encryption",
    "Reducing the frequency with which on-disk changes are reflected into the DB":
        "Reducing the frequency with which on-disk changes are reflected into the DB",
    Region: "Region",
    "Remote server type": "Remote server type",
    "Replicator.Message.Cleaned": "Database cleaning up is in process. replication has been cancelled",
    "Replicator.Message.InitialiseFatalError": "No replicator is available, this is the fatal error.",
    "Replicator.Message.Pending": "Some file events are pending. Replication has been cancelled.",
    "Replicator.Message.SomeModuleFailed": "Replication has been cancelled by some module failure",
    "Replicator.Message.VersionUpFlash":
        "An update has been detected. Please open the Settings dialogue and check the Change Log. Replication has been cancelled.",
    "Requires restart of Obsidian.": "Requires restart of Obsidian.",
    "Room ID": "Room ID",
    "Rotation Duration": "Rotation Duration",
    "Save settings to a markdown file. You will be notified when new settings arrive. You can set different files by the platform.":
        "Save settings to a markdown file. You will be notified when new settings arrive. You can set different files by the platform.",
    "Saving will be performed forcefully after this number of seconds.":
        "Saving will be performed forcefully after this number of seconds.",
    "Scan changes on customization sync": "Scan changes on customization sync",
    "Scan customization automatically": "Scan customization automatically",
    "Scan customization before replicating.": "Scan customization before replicating.",
    "Scan customization every 1 minute.": "Scan customization every 1 minute.",
    "Scan customization periodically": "Scan customization periodically",
    "Scan for hidden files before replication": "Scan for hidden files before replication",
    "Scan hidden files periodically": "Scan hidden files periodically",
    "Seconds, 0 to disable": "Seconds, 0 to disable",
    "Seconds. Saving to the local database will be delayed until this value after we stop typing or saving.":
        "Seconds. Saving to the local database will be delayed until this value after we stop typing or saving.",
    "Secret Key": "Secret Key",
    "Server URI": "Server URI",
    "Setup.QRCode":
        'We have generated a QR code to transfer the settings. Please scan the QR code with your phone or other device.\nNote: The QR code is not encrypted, so be careful to open this.\n\n>[!FOR YOUR EYES ONLY]-\n> <div class="sls-qr">${qr_image}</div>',
    "Should we keep folders that don't have any files inside?":
        "Should we keep folders that don't have any files inside?",
    "Should we only check for conflicts when a file is opened?":
        "Should we only check for conflicts when a file is opened?",
    "Should we prompt you about conflicting files when a file is opened?":
        "Should we prompt you about conflicting files when a file is opened?",
    "Should we prompt you for every single merge, even if we can safely merge automatcially?":
        "Should we prompt you for every single merge, even if we can safely merge automatcially?",
    "Show only notifications": "Show only notifications",
    "Show status as icons only": "Show status as icons only",
    "Show status icon instead of file warnings banner": "Show status icon instead of file warnings banner",
    "Show status inside the editor": "Show status inside the editor",
    "Show status on the status bar": "Show status on the status bar",
    "Show verbose log. Please enable if you report an issue.":
        "Show verbose log. Please enable if you report an issue.",
    "Signalling Relays": "Signalling Relays",
    "Starts synchronisation when a file is saved.": "Starts synchronisation when a file is saved.",
    "Stop reflecting database changes to storage files.": "Stop reflecting database changes to storage files.",
    "Stop watching for file changes.": "Stop watching for file changes.",
    "Subject (whoami)": "Subject (whoami)",
    "Suppress notification of hidden files change": "Suppress notification of hidden files change",
    "Suspend database reflecting": "Suspend database reflecting",
    "Suspend file watching": "Suspend file watching",
    "Sync Mode": "Sync Mode",
    "Sync after merging file": "Sync after merging file",
    "Sync automatically after merging files": "Sync automatically after merging files",
    "Sync on Editor Save": "Sync on Editor Save",
    "Sync on File Open": "Sync on File Open",
    "Sync on Save": "Sync on Save",
    "Sync on Startup": "Sync on Startup",
    "TURN Credential": "TURN Credential",
    "TURN Servers": "TURN Servers",
    "TURN Username": "TURN Username",
    "Testing only - Resolve file conflicts by syncing newer copies of the file, this can overwrite modified files. Be Warned.":
        "Testing only - Resolve file conflicts by syncing newer copies of the file, this can overwrite modified files. Be Warned.",
    "The Application ID for P2P connection. This should be same among your devices. Default is 'self-hosted-livesync' and could not be modified from the UI.":
        "The Application ID for P2P connection. This should be same among your devices. Default is 'self-hosted-livesync' and could not be modified from the UI.",
    "The Hash algorithm for chunk IDs": "The Hash algorithm for chunk IDs",
    "The Nostr relay servers to establish connections for P2P connections. Multiple servers can be separated by commas.":
        "The Nostr relay servers to establish connections for P2P connections. Multiple servers can be separated by commas.",
    "The Passphrase for P2P connection. This should be same among your devices.":
        "The Passphrase for P2P connection. This should be same among your devices.",
    "The Room ID for P2P connection. This should be same among your devices.":
        "The Room ID for P2P connection. This should be same among your devices.",
    "The Rotation duration of token in minutes. Each generated tokens will be valid only within this duration.":
        "The Rotation duration of token in minutes. Each generated tokens will be valid only within this duration.",
    "The TURN servers to use for P2P connections. Multiple servers can be separated by commas.":
        "The TURN servers to use for P2P connections. Multiple servers can be separated by commas.",
    "The algorithm used for JWT authentication.": "The algorithm used for JWT authentication.",
    "The credential/password for the TURN servers.": "The credential/password for the TURN servers.",
    "The delay for consecutive on-demand fetches": "The delay for consecutive on-demand fetches",
    "The key (PSK in HSxxx in base64, or private key in ESxxx in PEM) used for JWT authentication.":
        "The key (PSK in HSxxx in base64, or private key in ESxxx in PEM) used for JWT authentication.",
    "The key ID. this should be matched with CouchDB->jwt_keys->ALG:_`kid`.":
        "The key ID. this should be matched with CouchDB->jwt_keys->ALG:_`kid`.",
    "The maximum duration for which chunks can be incubated within the document. Chunks exceeding this period will graduate to independent chunks.":
        "The maximum duration for which chunks can be incubated within the document. Chunks exceeding this period will graduate to independent chunks.",
    "The maximum number of chunks that can be incubated within the document. Chunks exceeding this number will immediately graduate to independent chunks.":
        "The maximum number of chunks that can be incubated within the document. Chunks exceeding this number will immediately graduate to independent chunks.",
    "The maximum total size of chunks that can be incubated within the document. Chunks exceeding this size will immediately graduate to independent chunks.":
        "The maximum total size of chunks that can be incubated within the document. Chunks exceeding this size will immediately graduate to independent chunks.",
    "The minimum interval for automatic synchronisation on event.":
        "The minimum interval for automatic synchronisation on event.",
    "The subject for JWT authentication. Mostly username.": "The subject for JWT authentication. Mostly username.",
    "The username for the TURN servers.": "The username for the TURN servers.",
    "This passphrase will not be copied to another device. It will be set to `Default` until you configure it again.":
        "This passphrase will not be copied to another device. It will be set to `Default` until you configure it again.",
    "Unique name between all synchronized devices. To edit this setting, please disable customization sync once.":
        "Unique name between all synchronized devices. To edit this setting, please disable customization sync once.",
    "Use Custom HTTP Handler": "Use Custom HTTP Handler",
    "Use JWT instead of Basic Authentication": "Use JWT instead of Basic Authentication",
    "Use Only Local Chunks": "Use Only Local Chunks",
    "Use Request API to avoid `inevitable` CORS problem": "Use Request API to avoid `inevitable` CORS problem",
    "Use Segmented-splitter": "Use Segmented-splitter",
    "Use dynamic iteration count": "Use dynamic iteration count",
    "Use splitting-limit-capped chunk splitter": "Use splitting-limit-capped chunk splitter",
    "Use the trash bin": "Use the trash bin",
    "Use timeouts instead of heartbeats": "Use timeouts instead of heartbeats",
    Username: "Username",
    "Verbose Log": "Verbose Log",
    "Warning! This will have a serious impact on performance. And the logs will not be synchronised under the default name. Please be careful with logs; they often contain your confidential information.":
        "Warning! This will have a serious impact on performance. And the logs will not be synchronised under the default name. Please be careful with logs; they often contain your confidential information.",
    "When you save a file in the editor, start a sync automatically":
        "When you save a file in the editor, start a sync automatically",
    "While enabled, it causes very performance impact but debugging replication testing and other features will be enabled. Please disable this if you have not read the source code. Requires restart of Obsidian. Sometimes there is no implementation.":
        "While enabled, it causes very performance impact but debugging replication testing and other features will be enabled. Please disable this if you have not read the source code. Requires restart of Obsidian. Sometimes there is no implementation.",
    "Write credentials in the file": "Write credentials in the file",
    "Write logs into the file": "Write logs into the file",
    "You can enable this setting to process the files with size mismatches, these files can be created by some APIs or integrations.":
        "You can enable this setting to process the files with size mismatches, these files can be created by some APIs or integrations.",
    "liveSyncReplicator.beforeLiveSync": "Before LiveSync, start OneShot once...",
    "liveSyncReplicator.cantReplicateLowerValue": "We can't replicate more lower value.",
    "liveSyncReplicator.checkingLastSyncPoint": "Looking for the point last synchronized point.",
    "liveSyncReplicator.couldNotConnectTo": "Could not connect to ${uri} : ${name}\n(${db})",
    "liveSyncReplicator.couldNotConnectToRemoteDb": "Could not connect to remote database: ${d}",
    "liveSyncReplicator.couldNotConnectToServer": "The connection to the remote has been prevented, or failed.",
    "liveSyncReplicator.couldNotConnectToURI": "Could not connect to ${uri}:${dbRet}",
    "liveSyncReplicator.couldNotMarkResolveRemoteDb": "Could not mark resolve remote database.",
    "liveSyncReplicator.liveSyncBegin": "LiveSync begin...",
    "liveSyncReplicator.lockRemoteDb": "Lock remote database to prevent data corruption",
    "liveSyncReplicator.markDeviceResolved": "Mark this device as 'resolved'.",
    "liveSyncReplicator.mismatchedTweakDetected":
        "Some mismatches have been detected in the configuration between devices. Running a manual replication will attempt to resolve this issue.",
    "liveSyncReplicator.oneShotSyncBegin": "OneShot Sync begin... (${syncMode})",
    "liveSyncReplicator.remoteDbCorrupted":
        "Remote database is newer or corrupted, make sure to latest version of self-hosted-livesync installed",
    "liveSyncReplicator.remoteDbCreatedOrConnected": "Remote Database Created or Connected",
    "liveSyncReplicator.remoteDbDestroyError": "Something happened on Remote Database Destroy:",
    "liveSyncReplicator.remoteDbDestroyed": "Remote Database Destroyed",
    "liveSyncReplicator.remoteDbMarkedResolved": "Remote database has been marked resolved.",
    "liveSyncReplicator.replicationClosed": "Replication closed",
    "liveSyncReplicator.replicationInProgress": "Replication is already in progress",
    "liveSyncReplicator.retryLowerBatchSize": "Retry with lower batch size:${batch_size}/${batches_limit}",
    "liveSyncReplicator.unlockRemoteDb": "Unlock remote database to prevent data corruption",
    "moduleCheckRemoteSize.logCheckingStorageSizes": "Checking storage sizes",
    "moduleCheckRemoteSize.logCurrentStorageSize": "Remote storage size: ${measuredSize}",
    "moduleCheckRemoteSize.logExceededWarning": "Remote storage size: ${measuredSize} exceeded ${notifySize}",
    "moduleCheckRemoteSize.logThresholdEnlarged": "Threshold has been enlarged to ${size}MB",
    "moduleCheckRemoteSize.msgConfirmRebuild":
        "This may take a bit of a long time. Do you really want to rebuild everything now?",
    "moduleCheckRemoteSize.msgDatabaseGrowing":
        "**Your database is getting larger!** But do not worry, we can address it now. The time before running out of space on the remote storage.\n\n| Measured size | Configured size |\n| --- | --- |\n| ${estimatedSize} | ${maxSize} |\n\n> [!MORE]-\n> If you have been using it for many years, there may be unreferenced chunks - that is, garbage - accumulating in the database. Therefore, we recommend rebuilding everything. It will probably become much smaller.\n>\n> If the volume of your vault is simply increasing, it is better to rebuild everything after organizing the files. Self-hosted LiveSync does not delete the actual data even if you delete it to speed up the process. It is roughly [documented](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/tech_info.md).\n>\n> If you don't mind the increase, you can increase the notification limit by 100MB. This is the case if you are running it on your own server. However, it is better to rebuild everything from time to time.\n>\n\n> [!WARNING]\n> If you perform rebuild everything, make sure all devices are synchronised. The plug-in will merge as much as possible, though.\n",
    "moduleCheckRemoteSize.msgSetDBCapacity":
        "We can set a maximum database capacity warning, **to take action before running out of space on the remote storage**.\nDo you want to enable this?\n\n> [!MORE]-\n> - 0: Do not warn about storage size.\n>   This is recommended if you have enough space on the remote storage especially you have self-hosted. And you can check the storage size and rebuild manually.\n> - 800: Warn if the remote storage size exceeds 800MB.\n>   This is recommended if you are using fly.io with 1GB limit or IBM Cloudant.\n> - 2000: Warn if the remote storage size exceeds 2GB.\n\nIf we have reached the limit, we will be asked to enlarge the limit step by step.\n",
    "moduleCheckRemoteSize.noticeExceeded":
        "Remote storage size is ${measuredSize}, above the configured ${notifySize} notification threshold. {HERE}",
    "moduleCheckRemoteSize.noticeNotConfigured": "Remote storage size notifications are not configured. {HERE}",
    "moduleCheckRemoteSize.option2GB": "2GB (Standard)",
    "moduleCheckRemoteSize.option800MB": "800MB (Cloudant, fly.io)",
    "moduleCheckRemoteSize.optionAskMeLater": "Ask me later",
    "moduleCheckRemoteSize.optionDismiss": "Dismiss",
    "moduleCheckRemoteSize.optionIncreaseLimit": "increase to ${newMax}MB",
    "moduleCheckRemoteSize.optionNoWarn": "No, never warn please",
    "moduleCheckRemoteSize.optionRebuildAll": "Rebuild Everything Now",
    "moduleCheckRemoteSize.optionReview": "Review options",
    "moduleCheckRemoteSize.titleDatabaseSizeLimitExceeded": "Remote storage size exceeded the limit",
    "moduleCheckRemoteSize.titleDatabaseSizeNotify": "Setting up database size notification",
    "moduleLiveSyncMain.logUnloadingPlugin": "Unloading plugin...",
    "moduleLocalDatabase.logWaitingForReady": "Waiting for ready...",
    password: "password",
    username: "username",
    "xxhash64 is the current default.": "xxhash64 is the current default.",
} as const;

/** Message keys which Commonlib may request from a host translator. */
export type CommonlibMessageKey = keyof typeof commonlibEnglishMessages;
