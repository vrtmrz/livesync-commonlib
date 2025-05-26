export const PartialMessages = {
    zh: {
        "moduleMigration.logBulkSendCorrupted": "已启用批量发送 chunks，但此功能已损坏。给您带来不便，我们深表歉意。已自动禁用。",
        "moduleMigration.logMigrationFailed": "从 ${old} 到 ${current} 的迁移失败或已取消",
        "moduleMigration.logFetchRemoteTweakFailed": "获取远程调整值失败",
        "moduleMigration.logRemoteTweakUnavailable": "无法获取远程调整值",
        "moduleMigration.logMigratedSameBehaviour": "已迁移到 db:${current}，行为与之前相同",
        "moduleMigration.logRedflag2CreationFail": "创建 redflag2 失败",
        "moduleMigration.logLocalDatabaseNotReady": "出错了！本地数据库尚未准备好",
        "moduleMigration.logSetupCancelled": "设置已取消，Self-hosted LiveSync 正在等待您的设置！",
        "moduleMigration.titleCaseSensitivity": "大小写敏感性",
        "moduleMigration.msgFetchRemoteAgain": "您可能已经知道，Self-hosted LiveSync 更改了其默认行为和数据库结构。\n\
        \n\
        值得庆幸的是，在您的时间和努力下，远程数据库似乎已经迁移完成。恭喜！\n\
        \n\
        但是，我们还需要一点点操作。此设备的配置与远程数据库不兼容。我们需要再次从远程数据库获取。我们现在应该再次从远程获取吗？\n\
        \n\
        ___注意：在更改配置并再次获取数据库之前，我们无法进行同步。___\n\
        ___注意2：chunks 是完全不可变的，我们只能获取元数据和差异。___",
        "moduleMigration.optionYesFetchAgain": "是的，再次获取",
        "moduleMigration.optionNoAskAgain": "不，请稍后再次询问",
        "moduleMigration.msgSinceV02321": "自 v0.23.21 起，Self-hosted LiveSync 更改了默认行为和数据库结构。进行了以下更改：\n\
        \n\
        1. **文件名的区分大小写** \n\
           现在处理文件名时不区分大小写。这对于大多数平台来说是一个有益的更改，除了 Linux 和 iOS，它们不能有效地管理文件名的大小写敏感性。\n\
           （在这些平台上，对于名称相同但大小写不同的文件将显示警告）。\n\
        \n\
        2. **chunks 的版本处理** \n\
           chunks 是不可变的，这使得它们的版本可以固定。此更改将提高文件保存的性能。\n\
        \n\
        ___然而，要启用这些更改中的任何一个，都需要重建远程和本地数据库。这个过程需要几分钟，我们建议您在有充足时间时进行。___\n\
        \n\
        - 如果您希望保持以前的行为，可以使用 `${KEEP}` 跳过此过程。\n\
        - 如果您没有足够的时间，请选择 `${DISMISS}`。稍后会再次提示您。\n\
        - 如果您已在另一台设备上重建了数据库，请选择 `${DISMISS}` 并尝试再次同步。由于检测到差异，系统会再次提示您。",
        "moduleMigration.optionEnableBoth": "启用两者",
        "moduleMigration.optionEnableFilenameCaseInsensitive": "仅启用 #1",
        "moduleMigration.optionEnableFixedRevisionForChunks": "仅启用 #2",
        "moduleMigration.optionAdjustRemote": "调整到远程设置",
        "moduleMigration.optionKeepPreviousBehaviour": "保持以前的行为",
        "moduleMigration.optionDecideLater": "稍后决定",
        "moduleMigration.titleWelcome": "欢迎使用 Self-hosted LiveSync",
        "moduleMigration.msgInitialSetup": "您的设备**尚未设置**。让我引导您完成设置过程。\n\
        \n\
        请记住，每个对话框内容都可以复制到剪贴板。如果以后需要参考，可以将其粘贴到 Obsidian 的笔记中。您也可以使用翻译工具将其翻译成您的语言。\n\
        \n\
        首先，您有**设置 URI** 吗？\n\
        \n\
        注意：如果您不知道这是什么，请参阅[文档](${URI_DOC})。",
        "moduleMigration.docUri": "https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/zh/README_zh.md#%E5%A6%82%E4%BD%95%E4%BD%BF%E7%94%A8",
        "moduleMigration.optionHaveSetupUri": "是的，我有",
        "moduleMigration.optionNoSetupUri": "不，我没有",
        "moduleMigration.titleRecommendSetupUri": "推荐使用设置 URI",
        "moduleMigration.msgRecommendSetupUri": "我们强烈建议您生成一个设置 URI 并使用它。\n\
        如果您对此不了解，请参阅[文档](${URI_DOC})（再次抱歉，但这很重要）。\n\
        \n\
        您想如何手动设置？",
        "moduleMigration.optionSetupWizard": "带我进入设置向导",
        "moduleMigration.optionManualSetup": "全部手动设置",
        "moduleMigration.optionRemindNextLaunch": "下次启动时提醒我",
        "moduleLocalDatabase.logWaitingForReady": "等待就绪...",
        "moduleCheckRemoteSize.logCheckingStorageSizes": "正在检查存储大小",
        "moduleCheckRemoteSize.titleDatabaseSizeNotify": "设置数据库大小通知",
        "moduleCheckRemoteSize.msgSetDBCapacity": "我们可以设置一个最大数据库容量警告，**以便在远程存储空间耗尽前采取行动**。\n\
        您想启用这个功能吗？\n\
        \n\
        > [!MORE]-\n\
        > - 0: 不警告存储大小。\n\
        >   如果您在远程存储（尤其是自托管）上有足够的空间，则推荐此选项。您可以手动检查存储大小并重建。\n\
        > - 800: 如果远程存储大小超过 800MB 则发出警告。\n\
        >   如果您使用的是 fly.io（1GB 限制）或 IBM Cloudant，则推荐此选项。\n\
        > - 2000: 如果远程存储大小超过 2GB 则发出警告。\n\
        \n\
        如果达到限制，系统会要求我们逐步增大限制。\n\
        ",
        "moduleCheckRemoteSize.optionNoWarn": "不，请永远不要警告",
        "moduleCheckRemoteSize.option800MB": "800MB (Cloudant, fly.io)",
        "moduleCheckRemoteSize.option2GB": "2GB (标准)",
        "moduleCheckRemoteSize.optionAskMeLater": "稍后问我",
        "moduleCheckRemoteSize.titleDatabaseSizeLimitExceeded": "远程存储大小超出限制",
        "moduleCheckRemoteSize.msgDatabaseGrowing": "**您的数据库正在变大！** 但别担心，我们现在可以解决它。在远程存储空间用完之前还有时间。\n\
        \n\
        | 测量大小 | 配置大小 |\n\
        | --- | --- |\n\
        | ${estimatedSize} | ${maxSize} |\n\
        \n\
        > [!MORE]-\n\
        > 如果您已经使用了很多年，数据库中可能会积累未引用的 chunks——也就是垃圾。因此，我们建议重建所有内容。它可能会变得小得多。\n\
        > \n\
        > 如果您的库容量只是在增加，最好在整理文件后重建所有内容。即使您为了加速过程删除了文件，Self-hosted LiveSync 也不会删除实际数据。这大致[有文档记录](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/tech_info.md)。\n\
        > \n\
        > 如果您不介意增加，可以将通知限制增加 100MB。如果您在自己的服务器上运行，就是这种情况。但是，最好还是不时地重建所有内容。\n\
        > \n\
        \n\
        > [!WARNING]\n\
        > 如果您执行重建所有内容，请确保所有设备都已同步。尽管如此，插件会尽可能地合并。\n\
        ",
        "moduleCheckRemoteSize.optionIncreaseLimit": "增加到 ${newMax}MB",
        "moduleCheckRemoteSize.optionRebuildAll": "立即重建所有内容",
        "moduleCheckRemoteSize.optionDismiss": "忽略",
        "moduleCheckRemoteSize.msgConfirmRebuild": "这可能需要一些时间。您真的想现在重建所有内容吗？",
        "moduleCheckRemoteSize.logThresholdEnlarged": "阈值已扩大到 ${size}MB",
        "moduleCheckRemoteSize.logExceededWarning": "远程存储大小：${measuredSize} 超过 ${notifySize}",
        "moduleCheckRemoteSize.logCurrentStorageSize": "远程存储大小：${measuredSize}",
        "moduleInputUIObsidian.defaultTitleConfirmation": "确认",
        "moduleInputUIObsidian.optionYes": "是",
        "moduleInputUIObsidian.optionNo": "否",
        "moduleInputUIObsidian.defaultTitleSelect": "选择",
        "moduleLiveSyncMain.optionKeepLiveSyncDisabled": "保持 LiveSync 禁用",
        "moduleLiveSyncMain.optionResumeAndRestart": "恢复并重启 Obsidian",
        "moduleLiveSyncMain.msgScramEnabled": "Self-hosted LiveSync 已被配置为忽略某些事件。这样对吗？\n\
        \n\
        | 类型 | 状态 | 说明 |\n\
        |:---:|:---:|---|\n\
        | 存储事件 | ${fileWatchingStatus} | 所有修改都将被忽略 |\n\
        | 数据库事件 | ${parseReplicationStatus} | 所有同步的更改都将被推迟 |\n\
        \n\
        您想恢复它们并重启 Obsidian 吗？\n\
        \n\
        > [!DETAILS]-\n\
        > 这些标志是在重建或获取时由插件设置的。如果过程异常结束，它们可能会被无意中保留。\n\
        > 如果您不确定，可以尝试重新运行这些过程。请确保备份您的库。\n\
        ",
        "moduleLiveSyncMain.titleScramEnabled": "紧急停止已启用",
        "moduleLiveSyncMain.logAdditionalSafetyScan": "额外的安全扫描...",
        "moduleLiveSyncMain.logSafetyScanFailed": "额外的安全扫描在某个模块上失败",
        "moduleLiveSyncMain.logSafetyScanCompleted": "额外的安全扫描完成",
        "moduleLiveSyncMain.logLoadingPlugin": "正在加载插件...",
        "moduleLiveSyncMain.logPluginInitCancelled": "插件初始化被某个模块取消",
        "moduleLiveSyncMain.logPluginVersion": "Self-hosted LiveSync v${manifestVersion} ${packageVersion}",
        "moduleLiveSyncMain.logReadChangelog": "LiveSync 已更新，请阅读更新日志！",
        "moduleLiveSyncMain.logVersionUpdate": "LiveSync 已更新，如果存在破坏性更新，所有自动同步已暂时禁用。请确保所有设备都更新到最新版本后再启用。",
        "moduleLiveSyncMain.logUnloadingPlugin": "正在卸载插件...",
        "obsidianLiveSyncSettingTab.levelPowerUser": "（高级用户）",
        "obsidianLiveSyncSettingTab.levelAdvanced": "（进阶）",
        "obsidianLiveSyncSettingTab.levelEdgeCase": "（边缘情况）",
        "obsidianLiveSyncSettingTab.logEstimatedSize": "估计大小：${size}",
        "obsidianLiveSyncSettingTab.msgSettingModified": "设置 \"${setting}\" 已从另一台设备修改。点击 {HERE} 重新加载设置。点击其他地方忽略更改。",
        "obsidianLiveSyncSettingTab.optionHere": "这里",
        "obsidianLiveSyncSettingTab.logPassphraseInvalid": "密码无效，请修正。",
        "obsidianLiveSyncSettingTab.optionFetchFromRemote": "从远程获取",
        "obsidianLiveSyncSettingTab.optionRebuildBoth": "从此设备重建两者",
        "obsidianLiveSyncSettingTab.optionSaveOnlySettings": "（危险）仅保存设置",
        "obsidianLiveSyncSettingTab.optionCancel": "取消",
        "obsidianLiveSyncSettingTab.titleRebuildRequired": "需要重建",
        "obsidianLiveSyncSettingTab.msgRebuildRequired": "需要重建数据库以应用更改。请选择应用更改的方法。\n\
        \n\
        <details>\n\
        <summary>图例</summary>\n\
        \n\
        | 符号 | 含义 |\n\
        |: ------ :| ------- |\n\
        | ⇔ | 最新 |\n\
        | ⇄ | 同步以平衡 |\n\
        | ⇐,⇒ | 传输以覆盖 |\n\
        | ⇠,⇢ | 从另一侧传输以覆盖 |\n\
        \n\
        </details>\n\
        \n\
        ## ${OPTION_REBUILD_BOTH}\n\
        概览：📄 ⇒¹ 💻 ⇒² 🛰️ ⇢ⁿ 💻 ⇄ⁿ⁺¹ 📄\n\
        使用此设备的现有文件重建本地和远程数据库。\n\
        这将导致其他设备被锁定，并且它们需要执行获取操作。\n\
        ## ${OPTION_FETCH}\n\
        概览：📄 ⇄² 💻 ⇐¹ 🛰️ ⇔ 💻 ⇔ 📄\n\
        初始化本地数据库并使用从远程数据库获取的数据重建它。\n\
        这种情况包括您已经重建了远程数据库的情况。\n\
        ## ${OPTION_ONLY_SETTING}\n\
        仅存储设置。**注意：这可能导致数据损坏**；通常需要重建数据库。",
        "obsidianLiveSyncSettingTab.msgAreYouSureProceed": "您确定要继续吗？",
        "obsidianLiveSyncSettingTab.msgChangesNeedToBeApplied": "需要应用更改！",
        "obsidianLiveSyncSettingTab.optionApply": "应用",
        "obsidianLiveSyncSettingTab.logCheckPassphraseFailed": "错误：无法使用远程服务器检查密码：\n\
        ${db}。",
        "obsidianLiveSyncSettingTab.logDatabaseConnected": "数据库已连接",
        "obsidianLiveSyncSettingTab.logPassphraseNotCompatible": "错误：密码与远程服务器不兼容！请再次检查！",
        "obsidianLiveSyncSettingTab.logEncryptionNoPassphrase": "没有密码无法启用加密",
        "obsidianLiveSyncSettingTab.logEncryptionNoSupport": "您的设备不支持加密。",
        "obsidianLiveSyncSettingTab.logRebuildNote": "同步已禁用，如果需要，请获取并重新启用。",
        "obsidianLiveSyncSettingTab.panelChangeLog": "更新日志",
        "obsidianLiveSyncSettingTab.msgNewVersionNote": "因为升级通知来到这里？请查看版本历史。如果您满意，请点击按钮。新的更新将再次提示此信息。",
        "obsidianLiveSyncSettingTab.optionOkReadEverything": "好的，我已经阅读了所有内容。",
        "obsidianLiveSyncSettingTab.panelSetup": "设置",
        "obsidianLiveSyncSettingTab.titleQuickSetup": "快速设置",
        "obsidianLiveSyncSettingTab.nameConnectSetupURI": "使用设置 URI 连接",
        "obsidianLiveSyncSettingTab.descConnectSetupURI": "这是使用设置 URI 设置 Self-hosted LiveSync 的推荐方法。",
        "obsidianLiveSyncSettingTab.btnUse": "使用",
        "obsidianLiveSyncSettingTab.nameManualSetup": "手动设置",
        "obsidianLiveSyncSettingTab.descManualSetup": "不推荐，但如果您没有设置 URI 则很有用",
        "obsidianLiveSyncSettingTab.btnStart": "开始",
        "obsidianLiveSyncSettingTab.nameEnableLiveSync": "启用 LiveSync",
        "obsidianLiveSyncSettingTab.descEnableLiveSync": "仅在配置了上述两个选项之一或手动完成所有配置后启用此选项。",
        "obsidianLiveSyncSettingTab.btnEnable": "启用",
        "obsidianLiveSyncSettingTab.titleSetupOtherDevices": "设置其他设备",
        "obsidianLiveSyncSettingTab.nameCopySetupURI": "将当前设置复制为设置 URI",
        "obsidianLiveSyncSettingTab.descCopySetupURI": "非常适合设置新设备！",
        "obsidianLiveSyncSettingTab.btnCopy": "复制",
        "obsidianLiveSyncSettingTab.titleReset": "重置",
        "obsidianLiveSyncSettingTab.nameDiscardSettings": "丢弃现有设置和数据库",
        "obsidianLiveSyncSettingTab.btnDiscard": "丢弃",
        "obsidianLiveSyncSettingTab.msgDiscardConfirmation": "您真的要丢弃现有的设置和数据库吗？",
        "obsidianLiveSyncSettingTab.titleExtraFeatures": "启用额外和高级功能",
        "obsidianLiveSyncSettingTab.titleOnlineTips": "在线提示",
        "obsidianLiveSyncSettingTab.linkTroubleshooting": "/docs/troubleshooting.md",
        "obsidianLiveSyncSettingTab.linkOpenInBrowser": "在浏览器中打开",
        "obsidianLiveSyncSettingTab.logErrorOccurred": "发生错误！！",
        "obsidianLiveSyncSettingTab.linkTipsAndTroubleshooting": "提示和故障排除",
        "obsidianLiveSyncSettingTab.linkPageTop": "页面顶部",
        "obsidianLiveSyncSettingTab.panelGeneralSettings": "常规设置",
        "obsidianLiveSyncSettingTab.titleAppearance": "外观",
        "obsidianLiveSyncSettingTab.defaultLanguage": "默认",
        "obsidianLiveSyncSettingTab.titleLogging": "日志记录",
        "obsidianLiveSyncSettingTab.btnNext": "下一步",
        "obsidianLiveSyncSettingTab.logCheckingDbConfig": "正在检查数据库配置",
        "obsidianLiveSyncSettingTab.logCannotUseCloudant": "此功能不能与 IBM Cloudant 一起使用。",
        "obsidianLiveSyncSettingTab.btnFix": "修复",
        "obsidianLiveSyncSettingTab.logCouchDbConfigSet": "CouchDB 配置：${title} -> 设置 ${key} 为 ${value}",
        "obsidianLiveSyncSettingTab.logCouchDbConfigUpdated": "CouchDB 配置：${title} 成功更新",
        "obsidianLiveSyncSettingTab.logCouchDbConfigFail": "CouchDB 配置：${title} 失败",
        "obsidianLiveSyncSettingTab.msgNotice": "---注意---",
        "obsidianLiveSyncSettingTab.msgIfConfigNotPersistent": "如果服务器配置不是持久的（例如，在 docker 上运行），此处的值可能会更改。一旦能够连接，请更新服务器 local.ini 中的设置。",
        "obsidianLiveSyncSettingTab.msgConfigCheck": "--配置检查--",
        "obsidianLiveSyncSettingTab.warnNoAdmin": "⚠ 您没有管理员权限。",
        "obsidianLiveSyncSettingTab.okAdminPrivileges": "✔ 您拥有管理员权限。",
        "obsidianLiveSyncSettingTab.errRequireValidUser": "❗ chttpd.require_valid_user 设置错误。",
        "obsidianLiveSyncSettingTab.msgSetRequireValidUser": "设置 chttpd.require_valid_user = true",
        "obsidianLiveSyncSettingTab.okRequireValidUser": "✔ chttpd.require_valid_user 设置正确。",
        "obsidianLiveSyncSettingTab.errRequireValidUserAuth": "❗ chttpd_auth.require_valid_user 设置错误。",
        "obsidianLiveSyncSettingTab.msgSetRequireValidUserAuth": "设置 chttpd_auth.require_valid_user = true",
        "obsidianLiveSyncSettingTab.okRequireValidUserAuth": "✔ chttpd_auth.require_valid_user 设置正确。",
        "obsidianLiveSyncSettingTab.errMissingWwwAuth": "❗ 缺少 httpd.WWW-Authenticate 设置",
        "obsidianLiveSyncSettingTab.msgSetWwwAuth": "设置 httpd.WWW-Authenticate",
        "obsidianLiveSyncSettingTab.okWwwAuth": "✔ httpd.WWW-Authenticate 设置正确。",
        "obsidianLiveSyncSettingTab.errEnableCors": "❗ httpd.enable_cors 设置错误",
        "obsidianLiveSyncSettingTab.msgEnableCors": "设置 httpd.enable_cors",
        "obsidianLiveSyncSettingTab.okEnableCors": "✔ httpd.enable_cors 设置正确。",
        "obsidianLiveSyncSettingTab.errMaxRequestSize": "❗ chttpd.max_http_request_size 设置过低)",
        "obsidianLiveSyncSettingTab.msgSetMaxRequestSize": "设置 chttpd.max_http_request_size",
        "obsidianLiveSyncSettingTab.okMaxRequestSize": "✔ chttpd.max_http_request_size 设置正确。",
        "obsidianLiveSyncSettingTab.errMaxDocumentSize": "❗ couchdb.max_document_size 设置过低)",
        "obsidianLiveSyncSettingTab.msgSetMaxDocSize": "设置 couchdb.max_document_size",
        "obsidianLiveSyncSettingTab.okMaxDocumentSize": "✔ couchdb.max_document_size 设置正确。",
        "obsidianLiveSyncSettingTab.errCorsCredentials": "❗ cors.credentials 设置错误",
        "obsidianLiveSyncSettingTab.msgSetCorsCredentials": "设置 cors.credentials",
        "obsidianLiveSyncSettingTab.okCorsCredentials": "✔ cors.credentials 设置正确。",
        "obsidianLiveSyncSettingTab.okCorsOrigins": "✔ cors.origins 设置正确。",
        "obsidianLiveSyncSettingTab.errCorsOrigins": "❗ cors.origins 设置错误",
        "obsidianLiveSyncSettingTab.msgSetCorsOrigins": "设置 cors.origins",
        "obsidianLiveSyncSettingTab.msgConnectionCheck": "--连接检查--",
        "obsidianLiveSyncSettingTab.msgCurrentOrigin": "当前源: {origin}",
        "obsidianLiveSyncSettingTab.msgOriginCheck": "源检查: {org}",
        "obsidianLiveSyncSettingTab.errCorsNotAllowingCredentials": "❗ CORS 不允许凭据",
        "obsidianLiveSyncSettingTab.okCorsCredentialsForOrigin": "CORS 凭据正常",
        "obsidianLiveSyncSettingTab.warnCorsOriginUnmatched": "⚠ CORS 源不匹配 {from}->{to}",
        "obsidianLiveSyncSettingTab.okCorsOriginMatched": "✔ CORS 源正常",
        "obsidianLiveSyncSettingTab.msgDone": "--完成--",
        "obsidianLiveSyncSettingTab.msgConnectionProxyNote": "如果您在连接检查时遇到问题（即使检查了配置后），请检查您的反向代理配置。",
        "obsidianLiveSyncSettingTab.logCheckingConfigDone": "配置检查完成",
        "obsidianLiveSyncSettingTab.errAccessForbidden": "❗ 访问被禁止。",
        "obsidianLiveSyncSettingTab.errCannotContinueTest": "我们无法继续测试。",
        "obsidianLiveSyncSettingTab.logCheckingConfigFailed": "配置检查失败",
        "obsidianLiveSyncSettingTab.panelRemoteConfiguration": "远程配置",
        "obsidianLiveSyncSettingTab.titleRemoteServer": "远程服务器",
        "obsidianLiveSyncSettingTab.optionCouchDB": "CouchDB",
        "obsidianLiveSyncSettingTab.optionMinioS3R2": "Minio, S3, R2",
        "obsidianLiveSyncSettingTab.titleMinioS3R2": "Minio, S3, R2",
        "obsidianLiveSyncSettingTab.msgObjectStorageWarning": "警告：此功能仍在开发中，请注意以下几点：\n\
        - 仅追加架构。需要重建才能缩小存储空间。\n\
        - 有点脆弱。\n\
        - 首次同步时，所有历史记录将从远程传输。注意数据上限和慢速。\n\
        - 只有差异会实时同步。\n\
        \n\
        如果您遇到任何问题，或对此功能有任何想法，请在 GitHub 上创建 issue。\n\
        感谢您的巨大贡献。",
        "obsidianLiveSyncSettingTab.nameTestConnection": "测试连接",
        "obsidianLiveSyncSettingTab.btnTest": "测试",
        "obsidianLiveSyncSettingTab.nameApplySettings": "应用设置",
        "obsidianLiveSyncSettingTab.titleCouchDB": "CouchDB",
        "obsidianLiveSyncSettingTab.msgNonHTTPSWarning": "无法连接到非 HTTPS URI。请更新您的配置并重试。",
        "obsidianLiveSyncSettingTab.msgNonHTTPSInfo": "配置为非 HTTPS URI。请注意，这可能在移动设备上无法工作。",
        "obsidianLiveSyncSettingTab.msgSettingsUnchangeableDuringSync": "这些设置在同步期间无法更改。请在“同步设置”中禁用所有同步以解锁。",
        "obsidianLiveSyncSettingTab.nameTestDatabaseConnection": "测试数据库连接",
        "obsidianLiveSyncSettingTab.descTestDatabaseConnection": "打开数据库连接。如果未找到远程数据库并且您有创建数据库的权限，则将创建数据库。",
        "obsidianLiveSyncSettingTab.nameValidateDatabaseConfig": "验证数据库配置",
        "obsidianLiveSyncSettingTab.descValidateDatabaseConfig": "检查并修复数据库配置中的任何潜在问题。",
        "obsidianLiveSyncSettingTab.btnCheck": "检查",
        "obsidianLiveSyncSettingTab.titleNotification": "通知",
        "obsidianLiveSyncSettingTab.panelPrivacyEncryption": "隐私与加密",
        "obsidianLiveSyncSettingTab.titleFetchSettings": "获取设置",
        "obsidianLiveSyncSettingTab.titleFetchConfigFromRemote": "从远程服务器获取配置",
        "obsidianLiveSyncSettingTab.descFetchConfigFromRemote": "从已配置的远程服务器获取必要的设置。",
        "obsidianLiveSyncSettingTab.buttonFetch": "获取",
        "obsidianLiveSyncSettingTab.buttonNext": "下一步",
        "obsidianLiveSyncSettingTab.msgConfigCheckFailed": "配置检查失败。您仍要继续吗？",
        "obsidianLiveSyncSettingTab.titleRemoteConfigCheckFailed": "远程配置检查失败",
        "obsidianLiveSyncSettingTab.msgEnableEncryptionRecommendation": "我们建议启用端到端加密和路径混淆。您确定要在没有加密的情况下继续吗？",
        "obsidianLiveSyncSettingTab.titleEncryptionNotEnabled": "未启用加密",
        "obsidianLiveSyncSettingTab.msgInvalidPassphrase": "您的加密密码可能无效。您确定要继续吗？",
        "obsidianLiveSyncSettingTab.titleEncryptionPassphraseInvalid": "加密密码无效",
        "obsidianLiveSyncSettingTab.msgFetchConfigFromRemote": "您想从远程服务器获取配置吗？",
        "obsidianLiveSyncSettingTab.titleFetchConfig": "获取配置",
        "obsidianLiveSyncSettingTab.titleSyncSettings": "同步设置",
        "obsidianLiveSyncSettingTab.btnGotItAndUpdated": "我明白了并且已更新。",
        "obsidianLiveSyncSettingTab.msgSelectAndApplyPreset": "请选择并应用任何预设项以完成向导。",
        "obsidianLiveSyncSettingTab.titleSynchronizationPreset": "同步预设",
        "obsidianLiveSyncSettingTab.optionLiveSync": "LiveSync",
        "obsidianLiveSyncSettingTab.optionPeriodicWithBatch": "定期与批量",
        "obsidianLiveSyncSettingTab.optionDisableAllAutomatic": "禁用所有自动同步",
        "obsidianLiveSyncSettingTab.btnApply": "应用",
        "obsidianLiveSyncSettingTab.logSelectAnyPreset": "选择任何预设。",
        "obsidianLiveSyncSettingTab.logConfiguredLiveSync": "配置的同步模式：LiveSync",
        "obsidianLiveSyncSettingTab.logConfiguredPeriodic": "配置的同步模式：定期",
        "obsidianLiveSyncSettingTab.logConfiguredDisabled": "配置的同步模式：已禁用",
        "obsidianLiveSyncSettingTab.msgGenerateSetupURI": "全部完成！您想生成一个设置 URI 来设置其他设备吗？",
        "obsidianLiveSyncSettingTab.titleCongratulations": "恭喜！",
        "obsidianLiveSyncSettingTab.titleSynchronizationMethod": "同步方法",
        "obsidianLiveSyncSettingTab.optionOnEvents": "基于事件",
        "obsidianLiveSyncSettingTab.optionPeriodicAndEvents": "定期和基于事件",
        "obsidianLiveSyncSettingTab.titleUpdateThinning": "更新频率限制",
        "obsidianLiveSyncSettingTab.titleDeletionPropagation": "删除传播",
        "obsidianLiveSyncSettingTab.titleConflictResolution": "冲突解决",
        "obsidianLiveSyncSettingTab.titleSyncSettingsViaMarkdown": "通过 Markdown 同步设置",
        "obsidianLiveSyncSettingTab.titleHiddenFiles": "隐藏文件",
        "obsidianLiveSyncSettingTab.labelEnabled": "🔁 : 已启用",
        "obsidianLiveSyncSettingTab.labelDisabled": "⏹️ : 已禁用",
        "obsidianLiveSyncSettingTab.nameHiddenFileSynchronization": "隐藏文件同步",
        "obsidianLiveSyncSettingTab.nameDisableHiddenFileSync": "禁用隐藏文件同步",
        "obsidianLiveSyncSettingTab.btnDisable": "禁用",
        "obsidianLiveSyncSettingTab.nameEnableHiddenFileSync": "启用隐藏文件同步",
        "Enable advanced features": "启用高级功能",
        "Enable poweruser features": "启用高级用户功能",
        "Enable edge case treatment features": "启用边缘情况处理功能",
        "lang-de": "德语",
        "lang-es": "西班牙语",
        "lang-ja": "日语",
        "lang-ru": "俄语",
        "lang-zh": "简体中文",
        "lang-zh-tw": "繁體中文",
        "Display Language": "显示语言",
        'Not all messages have been translated. And, please revert to "Default" when reporting errors.': '并非所有消息都已翻译。请在报告错误时恢复为"Default"',
        "Show status inside the editor": "在编辑器内显示状态",
        "Requires restart of Obsidian.": "需要重启 Obsidian。",
        "Show status as icons only": "仅以图标显示状态",
        "Show status on the status bar": "在状态栏上显示状态",
        "Show only notifications": "仅显示通知",
        "Disables logging, only shows notifications. Please disable if you report an issue.": "禁用日志记录，仅显示通知。如果您报告问题，请禁用此选项。",
        "Verbose Log": "详细日志",
        "Show verbose log. Please enable if you report an issue.": "显示详细日志。如果您报告问题，请启用此选项。",
        "Remote Type": "远程类型",
        "Remote server type": "远程服务器类型",
        "Notify when the estimated remote storage size exceeds on start up": "启动时当估计的远程存储大小超出时通知",
        "MB (0 to disable).": "MB（0为禁用）。",
        "End-to-End Encryption": "端到端加密",
        "Encrypt contents on the remote database. If you use the plugin's synchronization feature, enabling this is recommended.": "加密远程数据库中的内容。如果您使用插件的同步功能，则建议启用此功能。",
        "Passphrase": "密码",
        "Encryption phassphrase. If changed, you should overwrite the server's database with the new (encrypted) files.": "加密密码。如果更改，您应该用新的（加密的）文件覆盖服务器的数据库。",
        "Path Obfuscation": "路径混淆",
        "Use dynamic iteration count": "使用动态迭代次数",
        "Presets": "预设",
        "Apply preset configuration": "应用预设配置",
        "Sync Mode": "同步模式",
        "Periodic Sync interval": "定期同步间隔",
        "Interval (sec)": "间隔（秒）",
        "Sync on Save": "保存时同步",
        "Starts synchronisation when a file is saved.": "当文件保存时启动同步。",
        "Sync on Editor Save": "编辑器保存时同步",
        "When you save a file in the editor, start a sync automatically": "当您在编辑器中保存文件时，自动开始同步",
        "Sync on File Open": "打开文件时同步",
        "Forces the file to be synced when opened.": "打开文件时强制同步该文件。",
        "Sync on Startup": "启动时同步",
        "Automatically Sync all files when opening Obsidian.": "打开 Obsidian 时自动同步所有文件。",
        "Sync after merging file": "合并文件后同步",
        "Sync automatically after merging files": "合并文件后自动同步",
        "Batch database update": "批量数据库更新",
        "Reducing the frequency with which on-disk changes are reflected into the DB": "降低将磁盘上的更改反映到数据库中的频率",
        "Minimum delay for batch database updating": "批量数据库更新的最小延迟",
        "Seconds. Saving to the local database will be delayed until this value after we stop typing or saving.": "秒。在我们停止输入或保存后，保存到本地数据库将延迟此值。",
        "Maximum delay for batch database updating": "批量数据库更新的最大延迟",
        "Saving will be performed forcefully after this number of seconds.": "在此秒数后将强制执行保存。",
        "Use the trash bin": "使用回收站",
        "Move remotely deleted files to the trash, instead of deleting.": "将远程删除的文件移至回收站，而不是直接删除。",
        "Keep empty folder": "保留空文件夹",
        "Should we keep folders that don't have any files inside?": "我们是否应该保留内部没有任何文件的文件夹？",
        "(BETA) Always overwrite with a newer file": "始终使用更新的文件覆盖（测试版）",
        "Testing only - Resolve file conflicts by syncing newer copies of the file, this can overwrite modified files. Be Warned.": "仅供测试 - 通过同步文件的较新副本来解决文件冲突，这可能会覆盖修改过的文件。请注意。",
        "Delay conflict resolution of inactive files": "推迟解决不活动文件",
        "Should we only check for conflicts when a file is opened?": "我们是否应该仅在文件打开时检查冲突？",
        "Delay merge conflict prompt for inactive files.": "推迟手动解决不活动文件",
        "Should we prompt you about conflicting files when a file is opened?": "当文件打开时，是否提示冲突文件？",
        "Filename": "文件名",
        "Save settings to a markdown file. You will be notified when new settings arrive. You can set different files by the platform.": "将设置保存到一个 Markdown 文件中。当新设置到达时，您将收到通知。您可以根据平台设置不同的文件。",
        "Write credentials in the file": "将凭据写入文件",
        "(Not recommended) If set, credentials will be stored in the file.": "（不建议）如果设置，凭据将存储在文件中。",
        "Notify all setting files": "通知所有设置文件",
        "Suppress notification of hidden files change": "抑制隐藏文件更改的通知",
        "If enabled, the notification of hidden files change will be suppressed.": "如果启用，隐藏文件更改的通知将被抑制。",
        "Scan for hidden files before replication": "复制前扫描隐藏文件",
        "Scan hidden files periodically": "定期扫描隐藏文件",
        "Seconds, 0 to disable": "秒，0为禁用",
        "Maximum file size": "最大文件大小",
        "(MB) If this is set, changes to local and remote files that are larger than this will be skipped. If the file becomes smaller again, a newer one will be used.": "（MB）如果设置了此项，大于此大小的本地和远程文件的更改将被跳过。如果文件再次变小，将使用更新的文件",
        "(Beta) Use ignore files": "（测试版）使用忽略文件",
        "If this is set, changes to local files which are matched by the ignore files will be skipped. Remote changes are determined using local ignore files.": "如果设置了此项，与忽略文件匹配的本地文件的更改将被跳过。远程更改使用本地忽略文件确定",
        "Ignore files": "忽略文件",
        "Comma separated `.gitignore, .dockerignore`": "用逗号分隔，例如 `.gitignore, .dockerignore`",
        "Device name": "设备名称",
        "Unique name between all synchronized devices. To edit this setting, please disable customization sync once.": "所有同步设备之间的唯一名称。要编辑此设置，请首先禁用自定义同步",
        "Per-file-saved customization sync": "按文件保存的自定义同步",
        "If enabled per-filed efficient customization sync will be used. We need a small migration when enabling this. And all devices should be updated to v0.23.18. Once we enabled this, we lost a compatibility with old versions.": "如果启用，将使用基于文件的、高效的自定义同步。启用此功能需要进行一次小的迁移。所有设备都应更新到 v0.23.18。一旦启用此功能，我们将失去与旧版本的兼容性。",
        "Enable customization sync": "启用自定义同步",
        "Scan customization automatically": "自动扫描自定义设置",
        "Scan customization before replicating.": "在复制前扫描自定义设置。",
        "Scan customization periodically": "定期扫描自定义设置",
        "Scan customization every 1 minute.": "每1分钟扫描自定义设置。",
        "Notify customized": "通知自定义设置",
        "Notify when other device has newly customized.": "当其他设备有新的自定义设置时通知。",
        "Write logs into the file": "将日志写入文件",
        "Warning! This will have a serious impact on performance. And the logs will not be synchronised under the default name. Please be careful with logs; they often contain your confidential information.": "警告！这将严重影响性能。并且日志不会以默认名称同步。请小心处理日志；它们通常包含您的敏感信息。",
        "Suspend file watching": "暂停文件监视",
        "Stop watching for file changes.": "停止监视文件更改。",
        "Suspend database reflecting": "暂停数据库反映",
        "Stop reflecting database changes to storage files.": "停止将数据库更改反映到存储文件。",
        "Memory cache size (by total items)": "内存缓存大小（按总项目数）",
        "Memory cache size (by total characters)": "内存缓存大小（按总字符数）",
        "(Mega chars)": "（百万字符）",
        "Enhance chunk size": "增强块大小",
        "Use splitting-limit-capped chunk splitter": "使用分割限制上限的块分割器",
        "If enabled, chunks will be split into no more than 100 items. However, dedupe is slightly weaker.": "如果启用，数据块将被分割成不超过 100 项。但是，去重效果会稍弱。",
        "Use Segmented-splitter": "使用分段分割器",
        "If this enabled, chunks will be split into semantically meaningful segments. Not all platforms support this feature.": "如果启用此功能，数据块将被分割成具有语义意义的段落。并非所有平台都支持此功能。",
        "Fetch chunks on demand": "按需获取块",
        "(ex. Read chunks online) If this option is enabled, LiveSync reads chunks online directly instead of replicating them locally. Increasing Custom chunk size is recommended.": "（例如，在线读取块）如果启用此选项，LiveSync 将直接在线读取块，而不是在本地复制块。建议增加自定义块大小",
        "Batch size of on-demand fetching": "按需获取的批量大小",
        "The delay for consecutive on-demand fetches": "连续按需获取的延迟",
        "Incubate Chunks in Document": "在文档中孵化块（测试版）",
        "If enabled, newly created chunks are temporarily kept within the document, and graduated to become independent chunks once stabilised.": "如果启用，新创建的数据块将暂时保留在文档中，并在稳定后成为独立数据块。",
        "Maximum Incubating Chunks": "最大孵化块数",
        "The maximum number of chunks that can be incubated within the document. Chunks exceeding this number will immediately graduate to independent chunks.": "文档中可以孵化的数据块的最大数量。超过此数量的数据块将立即成为独立数据块。",
        "Maximum Incubating Chunk Size": "最大孵化块大小",
        "The maximum total size of chunks that can be incubated within the document. Chunks exceeding this size will immediately graduate to independent chunks.": "文档中可以孵化的数据块的最大总大小。超过此大小的数据块将立即成为独立数据块。",
        "Maximum Incubation Period": "最大孵化期",
        "The maximum duration for which chunks can be incubated within the document. Chunks exceeding this period will graduate to independent chunks.": "文档中可以孵化的数据块的最大持续时间。超过此时间的数据块将成为独立数据块。",
        "Data Compression": "数据压缩（实验性）",
        "Batch size": "批量大小",
        "Number of changes to sync at a time. Defaults to 50. Minimum is 2.": "一次同步的更改数量。默认为 50。最小为 2。",
        "Batch limit": "批量限制",
        "Number of batches to process at a time. Defaults to 40. Minimum is 2. This along with batch size controls how many docs are kept in memory at a time.": "一次处理的批量数量。默认为 40。最小为 2。此设置与批量大小一起控制一次在内存中保留多少文档。",
        "Use timeouts instead of heartbeats": "使用超时而不是心跳",
        "If this option is enabled, PouchDB will hold the connection open for 60 seconds, and if no change arrives in that time, close and reopen the socket, instead of holding it open indefinitely. Useful when a proxy limits request duration but can increase resource usage.": "如果启用此选项，PouchDB 将保持连接打开 60 秒，如果在此时间内没有更改到达，则关闭并重新打开套接字，而不是无限期保持打开。当代理限制请求持续时间时有用，但可能会增加资源使用。",
        "Encrypting sensitive configuration items": "加密敏感配置项",
        "Passphrase of sensitive configuration items": "敏感配置项的密码",
        "This passphrase will not be copied to another device. It will be set to `Default` until you configure it again.": "此密码不会复制到另一台设备。在您再次配置之前，它将设置为 `Default`。",
        "Enable Developers' Debug Tools.": "启用开发者调试工具。",
        "Requires restart of Obsidian": "需要重启 Obsidian",
        "Do not keep metadata of deleted files.": "不保留已删除文件的元数据。",
        "Delete old metadata of deleted files on start-up": "启动时删除已删除文件的旧元数据",
        "(Days passed, 0 to disable automatic-deletion)": "（已过天数，0为禁用自动删除）",
        "Always prompt merge conflicts": "始终提示合并冲突",
        "Should we prompt you for every single merge, even if we can safely merge automatcially?": "即使我们可以安全地自动合并，是否也应该为每一次合并提示您？",
        "Apply Latest Change if Conflicting": "如果冲突则应用最新更改",
        "Enable this option to automatically apply the most recent change to documents even when it conflicts": "启用此选项可在文档冲突时自动应用最新的更改",
        "(Obsolete) Use an old adapter for compatibility": "（已弃用）为兼容性使用旧适配器",
        "Before v0.17.16, we used an old adapter for the local database. Now the new adapter is preferred. However, it needs local database rebuilding. Please disable this toggle when you have enough time. If leave it enabled, also while fetching from the remote database, you will be asked to disable this.": "在 v0.17.16 之前，我们使用旧适配器作为本地数据库。现在首选新适配器。但是，它需要重建本地数据库。请在有足够时间时禁用此开关。如果保持启用状态，并且在从远程数据库获取时，系统将要求您禁用此开关。",
        "Compute revisions for chunks (Previous behaviour)": "为 chunks 计算修订版本（以前的行为）",
        "If this enabled, all chunks will be stored with the revision made from its content. (Previous behaviour)": "如果启用，所有 chunks 将使用根据其内容生成的修订版本存储。（以前的行为）",
        "Handle files as Case-Sensitive": "将文件视为区分大小写",
        "If this enabled, All files are handled as case-Sensitive (Previous behaviour).": "如果启用，所有文件都将视为区分大小写（以前的行为）。",
        "Scan changes on customization sync": "在自定义同步时扫描更改",
        "Do not use internal API": "不使用内部 API",
        "Database suffix": "数据库后缀",
        "LiveSync could not handle multiple vaults which have same name without different prefix, This should be automatically configured.": "LiveSync 无法处理具有相同名称但没有不同前缀的多个库。这应该自动配置。",
        "The Hash algorithm for chunk IDs": "块 ID 的哈希算法（实验性）",
        "Fetch database with previous behaviour": "使用以前的行为获取数据库",
        "Do not split chunks in the background": "不在后台分割 chunks",
        "If disabled(toggled), chunks will be split on the UI thread (Previous behaviour).": "如果禁用（切换），chunks 将在 UI 线程上分割（以前的行为）。",
        "Process small files in the foreground": "在前台处理小文件",
        "If enabled, the file under 1kb will be processed in the UI thread.": "如果启用，小于 1kb 的文件将在 UI 线程中处理。",
        "Do not check configuration mismatch before replication": "在复制前不检查配置不匹配",
        "Endpoint URL": "Endpoint URL",
        "Access Key": "Access Key",
        "Secret Key": "Secret Key",
        "Region": "Region",
        "Bucket Name": "Bucket Name",
        "Use Custom HTTP Handler": "使用自定义 HTTP 处理程序",
        "Enable this if your Object Storage doesn't support CORS": "如果您的对象存储不支持 CORS，请启用此功能。",
        "Server URI": "服务器 URI",
        "Username": "用户名",
        "username": "用户名",
        "Password": "密码",
        "password": "密码",
        "Database Name": "数据库名称",
        "logPane.title": "Self-hosted LiveSync 日志",
        "logPane.wrap": "自动换行",
        "logPane.autoScroll": "自动滚动",
        "logPane.pause": "暂停",
    },
} as const;