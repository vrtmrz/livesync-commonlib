export const PartialMessages = {
    ja: {
        // "moduleMigration.logBulkSendCorrupted": "Send chunks in bulk has been enabled, however, this feature had been corrupted. Sorry for your inconvenience. Automatically disabled.",
        // "moduleMigration.logMigrationFailed": "Migration failed or cancelled from ${old} to ${current}",
        // "moduleMigration.logFetchRemoteTweakFailed": "Failed to fetch remote tweak values",
        // "moduleMigration.logRemoteTweakUnavailable": "Could not get remote tweak values",
        // "moduleMigration.logMigratedSameBehaviour": "Migrated to db:${current} with the same behaviour as before",
        // "moduleMigration.logRedflag2CreationFail": "Failed to create redflag2",
        // "moduleMigration.logLocalDatabaseNotReady": "Something went wrong! The local database is not ready",
        // "moduleMigration.logSetupCancelled": "The setup has been cancelled, Self-hosted LiveSync waiting for your setup!",
        // "moduleMigration.titleCaseSensitivity": "Case Sensitivity",
        // "moduleMigration.msgFetchRemoteAgain": "As you may already know, the self-hosted LiveSync has changed its default behaviour and database structure.\n\
        // \n\
        // And thankfully, with your time and efforts, the remote database appears to have already been migrated. Congratulations!\n\
        // \n\
        // However, we need a bit more. The configuration of this device is not compatible with the remote database. We will need to fetch the remote database again. Should we fetch from the remote again now?\n\
        // \n\
        // ___Note: We cannot synchronise until the configuration has been changed and the database has been fetched again.___\n\
        // ___Note2: The chunks are completely immutable, we can fetch only the metadata and difference.___",
        // "moduleMigration.optionYesFetchAgain": "Yes, fetch again",
        // "moduleMigration.optionNoAskAgain": "No, please ask again",
        // "moduleMigration.msgSinceV02321": "Since v0.23.21, the self-hosted LiveSync has changed the default behaviour and database structure. The following changes have been made:\n\
        // \n\
        // 1. **Case sensitivity of filenames** \n\
        //    The handling of filenames is now case-insensitive. This is a beneficial change for most platforms, other than Linux and iOS, which do not manage filename case sensitivity effectively.\n\
        //    (On These, a warning will be displayed for files with the same name but different cases).\n\
        // \n\
        // 2. **Revision handling of the chunks** \n\
        //    Chunks are immutable, which allows their revisions to be fixed. This change will enhance the performance of file saving.\n\
        // \n\
        // ___However, to enable either of these changes, both remote and local databases need to be rebuilt. This process takes a few minutes, and we recommend doing it when you have ample time.___\n\
        // \n\
        // - If you wish to maintain the previous behaviour, you can skip this process by using `${KEEP}`.\n\
        // - If you do not have enough time, please choose `${DISMISS}`. You will be prompted again later.\n\
        // - If you have rebuilt the database on another device, please select `${DISMISS}` and try synchronizing again. Since a difference has been detected, you will be prompted again.",
        // "moduleMigration.optionEnableBoth": "Enable both",
        // "moduleMigration.optionEnableFilenameCaseInsensitive": "Enable only #1",
        // "moduleMigration.optionEnableFixedRevisionForChunks": "Enable only #2",
        // "moduleMigration.optionAdjustRemote": "Adjust to remote",
        // "moduleMigration.optionKeepPreviousBehaviour": "Keep previous behaviour",
        // "moduleMigration.optionDecideLater": "Decide it later",
        // "moduleMigration.titleWelcome": "Welcome to Self-hosted LiveSync",
        // "moduleMigration.msgInitialSetup": "Your device has **not been set up yet**. Let me guide you through the setup process.\n\
        // \n\
        // Please keep in mind that every dialogue content can be copied to the clipboard. If you need to refer to it later, you can paste it into a note in Obsidian. You can also translate it into your language using a translation tool.\n\
        // \n\
        // First, do you have **Setup URI**?\n\
        // \n\
        // Note: If you do not know what it is, please refer to the [documentation](${URI_DOC}).",
        // "moduleMigration.docUri": "https://github.com/vrtmrz/obsidian-livesync/blob/main/README.md#how-to-use",
        // "moduleMigration.optionHaveSetupUri": "Yes, I have",
        // "moduleMigration.optionNoSetupUri": "No, I do not have",
        // "moduleMigration.titleRecommendSetupUri": "Recommendation to use Setup URI",
        // "moduleMigration.msgRecommendSetupUri": "We strongly recommend that you generate a set-up URI and use it.\n\
        // If you do not have knowledge about it, please refer to the [documentation](${URI_DOC}) (Sorry again, but it is important).\n\
        // \n\
        // How do you want to set it up manually?",
        // "moduleMigration.optionSetupWizard": "Take me into the setup wizard",
        // "moduleMigration.optionManualSetup": "Set it up all manually",
        // "moduleMigration.optionRemindNextLaunch": "Remind me at the next launch",
        "moduleLocalDatabase.logWaitingForReady": "しばらくお待ちください...",
        // "moduleCheckRemoteSize.logCheckingStorageSizes": "Checking storage sizes",
        // "moduleCheckRemoteSize.titleDatabaseSizeNotify": "Setting up database size notification",
        // "moduleCheckRemoteSize.msgSetDBCapacity": "We can set a maximum database capacity warning, **to take action before running out of space on the remote storage**.\n\
        // Do you want to enable this?\n\
        // \n\
        // > [!MORE]-\n\
        // > - 0: Do not warn about storage size.\n\
        // >   This is recommended if you have enough space on the remote storage especially you have self-hosted. And you can check the storage size and rebuild manually.\n\
        // > - 800: Warn if the remote storage size exceeds 800MB.\n\
        // >   This is recommended if you are using fly.io with 1GB limit or IBM Cloudant.\n\
        // > - 2000: Warn if the remote storage size exceeds 2GB.\n\
        // \n\
        // If we have reached the limit, we will be asked to enlarge the limit step by step.\n\
        // ",
        // "moduleCheckRemoteSize.optionNoWarn": "No, never warn please",
        // "moduleCheckRemoteSize.option800MB": "800MB (Cloudant, fly.io)",
        // "moduleCheckRemoteSize.option2GB": "2GB (Standard)",
        // "moduleCheckRemoteSize.optionAskMeLater": "Ask me later",
        // "moduleCheckRemoteSize.titleDatabaseSizeLimitExceeded": "Remote storage size exceeded the limit",
        // "moduleCheckRemoteSize.msgDatabaseGrowing": "**Your database is getting larger!** But do not worry, we can address it now. The time before running out of space on the remote storage.\n\
        // \n\
        // | Measured size | Configured size |\n\
        // | --- | --- |\n\
        // | ${estimatedSize} | ${maxSize} |\n\
        // \n\
        // > [!MORE]-\n\
        // > If you have been using it for many years, there may be unreferenced chunks - that is, garbage - accumulating in the database. Therefore, we recommend rebuilding everything. It will probably become much smaller.\n\
        // > \n\
        // > If the volume of your vault is simply increasing, it is better to rebuild everything after organizing the files. Self-hosted LiveSync does not delete the actual data even if you delete it to speed up the process. It is roughly [documented](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/tech_info.md).\n\
        // > \n\
        // > If you don't mind the increase, you can increase the notification limit by 100MB. This is the case if you are running it on your own server. However, it is better to rebuild everything from time to time.\n\
        // > \n\
        // \n\
        // > [!WARNING]\n\
        // > If you perform rebuild everything, make sure all devices are synchronised. The plug-in will merge as much as possible, though.\n\
        // ",
        // "moduleCheckRemoteSize.optionIncreaseLimit": "increase to ${newMax}MB",
        // "moduleCheckRemoteSize.optionRebuildAll": "Rebuild Everything Now",
        // "moduleCheckRemoteSize.optionDismiss": "Dismiss",
        // "moduleCheckRemoteSize.msgConfirmRebuild": "This may take a bit of a long time. Do you really want to rebuild everything now?",
        // "moduleCheckRemoteSize.logThresholdEnlarged": "Threshold has been enlarged to ${size}MB",
        // "moduleCheckRemoteSize.logExceededWarning": "Remote storage size: ${measuredSize} exceeded ${notifySize}",
        // "moduleCheckRemoteSize.logCurrentStorageSize": "Remote storage size: ${measuredSize}",
        // "moduleInputUIObsidian.defaultTitleConfirmation": "Confirmation",
        // "moduleInputUIObsidian.optionYes": "Yes",
        // "moduleInputUIObsidian.optionNo": "No",
        // "moduleInputUIObsidian.defaultTitleSelect": "Select",
        // "moduleLiveSyncMain.optionKeepLiveSyncDisabled": "Keep LiveSync disabled",
        // "moduleLiveSyncMain.optionResumeAndRestart": "Resume and restart Obsidian",
        // "moduleLiveSyncMain.msgScramEnabled": "Self-hosted LiveSync has been configured to ignore some events. Is this correct?\n\
        // \n\
        // | Type | Status | Note |\n\
        // |:---:|:---:|---|\n\
        // | Storage Events | ${fileWatchingStatus} | Every modification will be ignored |\n\
        // | Database Events | ${parseReplicationStatus} | Every synchronised change will be postponed |\n\
        // \n\
        // Do you want to resume them and restart Obsidian?\n\
        // \n\
        // > [!DETAILS]-\n\
        // > These flags are set by the plug-in while rebuilding, or fetching. If the process ends abnormally, it may be kept unintended.\n\
        // > If you are not sure, you can try to rerun these processes. Make sure to back your vault up.\n\
        // ",
        // "moduleLiveSyncMain.titleScramEnabled": "Scram Enabled",
        // "moduleLiveSyncMain.logAdditionalSafetyScan": "Additional safety scan...",
        // "moduleLiveSyncMain.logSafetyScanFailed": "Additional safety scan has failed on a module",
        // "moduleLiveSyncMain.logSafetyScanCompleted": "Additional safety scan completed",
        // "moduleLiveSyncMain.logLoadingPlugin": "Loading plugin...",
        // "moduleLiveSyncMain.logPluginInitCancelled": "Plugin initialisation was cancelled by a module",
        // "moduleLiveSyncMain.logPluginVersion": "Self-hosted LiveSync v${manifestVersion} ${packageVersion}",
        // "moduleLiveSyncMain.logReadChangelog": "LiveSync has updated, please read the changelog!",
        // "moduleLiveSyncMain.logVersionUpdate": "LiveSync has been updated, In case of breaking updates, all automatic synchronization has been temporarily disabled. Ensure that all devices are up to date before enabling.",
        // "moduleLiveSyncMain.logUnloadingPlugin": "Unloading plugin...",
        // "obsidianLiveSyncSettingTab.levelPowerUser": " (Power User)",
        // "obsidianLiveSyncSettingTab.levelAdvanced": " (Advanced)",
        // "obsidianLiveSyncSettingTab.levelEdgeCase": " (Edge Case)",
        // "obsidianLiveSyncSettingTab.logEstimatedSize": "Estimated size: ${size}",
        // "obsidianLiveSyncSettingTab.msgSettingModified": "The setting \"${setting}\" was modified from another device. Click {HERE} to reload settings. Click elsewhere to ignore changes.",
        // "obsidianLiveSyncSettingTab.optionHere": "HERE",
        // "obsidianLiveSyncSettingTab.logPassphraseInvalid": "Passphrase is not valid, please fix it.",
        // "obsidianLiveSyncSettingTab.optionFetchFromRemote": "Fetch from Remote",
        // "obsidianLiveSyncSettingTab.optionRebuildBoth": "Rebuild Both from This Device",
        // "obsidianLiveSyncSettingTab.optionSaveOnlySettings": "(Danger) Save Only Settings",
        // "obsidianLiveSyncSettingTab.optionCancel": "Cancel",
        // "obsidianLiveSyncSettingTab.titleRebuildRequired": "Rebuild Required",
        // "obsidianLiveSyncSettingTab.msgRebuildRequired": "Rebuilding Databases are required to apply the changes.. Please select the method to apply the changes.\n\
        // \n\
        // <details>\n\
        // <summary>Legends</summary>\n\
        // \n\
        // | Symbol | Meaning |\n\
        // |: ------ :| ------- |\n\
        // | ⇔ | Up to Date |\n\
        // | ⇄ | Synchronise to balance |\n\
        // | ⇐,⇒ | Transfer to overwrite |\n\
        // | ⇠,⇢ | Transfer to overwrite from other side |\n\
        // \n\
        // </details>\n\
        // \n\
        // ## ${OPTION_REBUILD_BOTH}\n\
        // At a glance:  📄 ⇒¹ 💻 ⇒² 🛰️ ⇢ⁿ 💻 ⇄ⁿ⁺¹ 📄\n\
        // Reconstruct both the local and remote databases using existing files from this device.\n\
        // This causes a lockout other devices, and they need to perform fetching.\n\
        // ## ${OPTION_FETCH}\n\
        // At a glance: 📄 ⇄² 💻 ⇐¹ 🛰️ ⇔ 💻 ⇔ 📄\n\
        // Initialise the local database and reconstruct it using data fetched from the remote database.\n\
        // This case includes the case which you have rebuilt the remote database.\n\
        // ## ${OPTION_ONLY_SETTING}\n\
        // Store only the settings. **Caution: This may lead to data corruption**; database reconstruction is generally necessary.",
        // "obsidianLiveSyncSettingTab.msgAreYouSureProceed": "Are you sure to proceed?",
        // "obsidianLiveSyncSettingTab.msgChangesNeedToBeApplied": "Changes need to be applied!",
        // "obsidianLiveSyncSettingTab.optionApply": "Apply",
        // "obsidianLiveSyncSettingTab.logCheckPassphraseFailed": "ERROR: Failed to check passphrase with the remote server: \n\
        // ${db}.",
        // "obsidianLiveSyncSettingTab.logDatabaseConnected": "Database connected",
        // "obsidianLiveSyncSettingTab.logPassphraseNotCompatible": "ERROR: Passphrase is not compatible with the remote server! Please check it again!",
        // "obsidianLiveSyncSettingTab.logEncryptionNoPassphrase": "You cannot enable encryption without a passphrase",
        // "obsidianLiveSyncSettingTab.logEncryptionNoSupport": "Your device does not support encryption.",
        // "obsidianLiveSyncSettingTab.logRebuildNote": "Syncing has been disabled, fetch and re-enabled if desired.",
        // "obsidianLiveSyncSettingTab.panelChangeLog": "Change Log",
        // "obsidianLiveSyncSettingTab.msgNewVersionNote": "Here due to an upgrade notification? Please review the version history. If you're satisfied, click the button. A new update will prompt this again.",
        // "obsidianLiveSyncSettingTab.optionOkReadEverything": "OK, I have read everything.",
        // "obsidianLiveSyncSettingTab.panelSetup": "Setup",
        // "obsidianLiveSyncSettingTab.titleQuickSetup": "Quick Setup",
        // "obsidianLiveSyncSettingTab.nameConnectSetupURI": "Connect with Setup URI",
        // "obsidianLiveSyncSettingTab.descConnectSetupURI": "This is the recommended method to set up Self-hosted LiveSync with a Setup URI.",
        // "obsidianLiveSyncSettingTab.btnUse": "Use",
        // "obsidianLiveSyncSettingTab.nameManualSetup": "Manual Setup",
        // "obsidianLiveSyncSettingTab.descManualSetup": "Not recommended, but useful if you don't have a Setup URI",
        // "obsidianLiveSyncSettingTab.btnStart": "Start",
        // "obsidianLiveSyncSettingTab.nameEnableLiveSync": "Enable LiveSync",
        // "obsidianLiveSyncSettingTab.descEnableLiveSync": "Only enable this after configuring either of the above two options or completing all configuration manually.",
        // "obsidianLiveSyncSettingTab.btnEnable": "Enable",
        // "obsidianLiveSyncSettingTab.titleSetupOtherDevices": "To setup other devices",
        // "obsidianLiveSyncSettingTab.nameCopySetupURI": "Copy the current settings to a Setup URI",
        // "obsidianLiveSyncSettingTab.descCopySetupURI": "Perfect for setting up a new device!",
        // "obsidianLiveSyncSettingTab.btnCopy": "Copy",
        // "obsidianLiveSyncSettingTab.titleReset": "Reset",
        // "obsidianLiveSyncSettingTab.nameDiscardSettings": "Discard existing settings and databases",
        // "obsidianLiveSyncSettingTab.btnDiscard": "Discard",
        // "obsidianLiveSyncSettingTab.msgDiscardConfirmation": "Do you really want to discard existing settings and databases?",
        // "obsidianLiveSyncSettingTab.titleExtraFeatures": "Enable extra and advanced features",
        // "obsidianLiveSyncSettingTab.titleOnlineTips": "Online Tips",
        // "obsidianLiveSyncSettingTab.linkTroubleshooting": "/docs/troubleshooting.md",
        // "obsidianLiveSyncSettingTab.linkOpenInBrowser": "Open in browser",
        // "obsidianLiveSyncSettingTab.logErrorOccurred": "An error occurred!!",
        // "obsidianLiveSyncSettingTab.linkTipsAndTroubleshooting": "Tips and Troubleshooting",
        // "obsidianLiveSyncSettingTab.linkPageTop": "Page Top",
        // "obsidianLiveSyncSettingTab.panelGeneralSettings": "General Settings",
        // "obsidianLiveSyncSettingTab.titleAppearance": "Appearance",
        // "obsidianLiveSyncSettingTab.defaultLanguage": "Default",
        // "obsidianLiveSyncSettingTab.titleLogging": "Logging",
        // "obsidianLiveSyncSettingTab.btnNext": "Next",
        // "obsidianLiveSyncSettingTab.logCheckingDbConfig": "Checking database configuration",
        // "obsidianLiveSyncSettingTab.logCannotUseCloudant": "This feature cannot be used with IBM Cloudant.",
        // "obsidianLiveSyncSettingTab.btnFix": "Fix",
        // "obsidianLiveSyncSettingTab.logCouchDbConfigSet": "CouchDB Configuration: ${title} -> Set ${key} to ${value}",
        // "obsidianLiveSyncSettingTab.logCouchDbConfigUpdated": "CouchDB Configuration: ${title} successfully updated",
        // "obsidianLiveSyncSettingTab.logCouchDbConfigFail": "CouchDB Configuration: ${title} failed",
        // "obsidianLiveSyncSettingTab.msgNotice": "---Notice---",
        // "obsidianLiveSyncSettingTab.msgIfConfigNotPersistent": "If the server configuration is not persistent (e.g., running on docker), the values here may change. Once you are able to connect, please update the settings in the server's local.ini.",
        // "obsidianLiveSyncSettingTab.msgConfigCheck": "--Config check--",
        // "obsidianLiveSyncSettingTab.warnNoAdmin": "⚠ You do not have administrator privileges.",
        // "obsidianLiveSyncSettingTab.okAdminPrivileges": "✔ You have administrator privileges.",
        // "obsidianLiveSyncSettingTab.errRequireValidUser": "❗ chttpd.require_valid_user is wrong.",
        // "obsidianLiveSyncSettingTab.msgSetRequireValidUser": "Set chttpd.require_valid_user = true",
        // "obsidianLiveSyncSettingTab.okRequireValidUser": "✔ chttpd.require_valid_user is ok.",
        // "obsidianLiveSyncSettingTab.errRequireValidUserAuth": "❗ chttpd_auth.require_valid_user is wrong.",
        // "obsidianLiveSyncSettingTab.msgSetRequireValidUserAuth": "Set chttpd_auth.require_valid_user = true",
        // "obsidianLiveSyncSettingTab.okRequireValidUserAuth": "✔ chttpd_auth.require_valid_user is ok.",
        // "obsidianLiveSyncSettingTab.errMissingWwwAuth": "❗ httpd.WWW-Authenticate is missing",
        // "obsidianLiveSyncSettingTab.msgSetWwwAuth": "Set httpd.WWW-Authenticate",
        // "obsidianLiveSyncSettingTab.okWwwAuth": "✔ httpd.WWW-Authenticate is ok.",
        // "obsidianLiveSyncSettingTab.errEnableCors": "❗ httpd.enable_cors is wrong",
        // "obsidianLiveSyncSettingTab.msgEnableCors": "Set httpd.enable_cors",
        // "obsidianLiveSyncSettingTab.okEnableCors": "✔ httpd.enable_cors is ok.",
        // "obsidianLiveSyncSettingTab.errMaxRequestSize": "❗ chttpd.max_http_request_size is low)",
        // "obsidianLiveSyncSettingTab.msgSetMaxRequestSize": "Set chttpd.max_http_request_size",
        // "obsidianLiveSyncSettingTab.okMaxRequestSize": "✔ chttpd.max_http_request_size is ok.",
        // "obsidianLiveSyncSettingTab.errMaxDocumentSize": "❗ couchdb.max_document_size is low)",
        // "obsidianLiveSyncSettingTab.msgSetMaxDocSize": "Set couchdb.max_document_size",
        // "obsidianLiveSyncSettingTab.okMaxDocumentSize": "✔ couchdb.max_document_size is ok.",
        // "obsidianLiveSyncSettingTab.errCorsCredentials": "❗ cors.credentials is wrong",
        // "obsidianLiveSyncSettingTab.msgSetCorsCredentials": "Set cors.credentials",
        // "obsidianLiveSyncSettingTab.okCorsCredentials": "✔ cors.credentials is ok.",
        // "obsidianLiveSyncSettingTab.okCorsOrigins": "✔ cors.origins is ok.",
        // "obsidianLiveSyncSettingTab.errCorsOrigins": "❗ cors.origins is wrong",
        // "obsidianLiveSyncSettingTab.msgSetCorsOrigins": "Set cors.origins",
        // "obsidianLiveSyncSettingTab.msgConnectionCheck": "--Connection check--",
        // "obsidianLiveSyncSettingTab.msgCurrentOrigin": "Current origin: {origin}",
        // "obsidianLiveSyncSettingTab.msgOriginCheck": "Origin check: {org}",
        // "obsidianLiveSyncSettingTab.errCorsNotAllowingCredentials": "❗ CORS is not allowing credentials",
        // "obsidianLiveSyncSettingTab.okCorsCredentialsForOrigin": "CORS credentials OK",
        // "obsidianLiveSyncSettingTab.warnCorsOriginUnmatched": "⚠ CORS Origin is unmatched {from}->{to}",
        // "obsidianLiveSyncSettingTab.okCorsOriginMatched": "✔ CORS origin OK",
        // "obsidianLiveSyncSettingTab.msgDone": "--Done--",
        // "obsidianLiveSyncSettingTab.msgConnectionProxyNote": "If you're having trouble with the Connection-check (even after checking config), please check your reverse proxy configuration.",
        // "obsidianLiveSyncSettingTab.logCheckingConfigDone": "Checking configuration done",
        // "obsidianLiveSyncSettingTab.errAccessForbidden": "❗ Access forbidden.",
        // "obsidianLiveSyncSettingTab.errCannotContinueTest": "We could not continue the test.",
        // "obsidianLiveSyncSettingTab.logCheckingConfigFailed": "Checking configuration failed",
        // "obsidianLiveSyncSettingTab.panelRemoteConfiguration": "Remote Configuration",
        // "obsidianLiveSyncSettingTab.titleRemoteServer": "Remote Server",
        // "obsidianLiveSyncSettingTab.optionCouchDB": "CouchDB",
        // "obsidianLiveSyncSettingTab.optionMinioS3R2": "Minio,S3,R2",
        // "obsidianLiveSyncSettingTab.titleMinioS3R2": "Minio,S3,R2",
        // "obsidianLiveSyncSettingTab.msgObjectStorageWarning": "WARNING: This feature is a Work In Progress, so please keep in mind the following:\n\
        // - Append only architecture. A rebuild is required to shrink the storage.\n\
        // - A bit fragile.\n\
        // - When first syncing, all history will be transferred from the remote. Be mindful of data caps and slow speeds.\n\
        // - Only differences are synced live.\n\
        // \n\
        // If you run into any issues, or have ideas about this feature, please create a issue on GitHub.\n\
        // I appreciate you for your great dedication.",
        // "obsidianLiveSyncSettingTab.nameTestConnection": "Test Connection",
        // "obsidianLiveSyncSettingTab.btnTest": "Test",
        // "obsidianLiveSyncSettingTab.nameApplySettings": "Apply Settings",
        // "obsidianLiveSyncSettingTab.titleCouchDB": "CouchDB",
        // "obsidianLiveSyncSettingTab.msgNonHTTPSWarning": "Cannot connect to non-HTTPS URI. Please update your config and try again.",
        // "obsidianLiveSyncSettingTab.msgNonHTTPSInfo": "Configured as non-HTTPS URI. Be warned that this may not work on mobile devices.",
        // "obsidianLiveSyncSettingTab.msgSettingsUnchangeableDuringSync": "These settings are unable to be changed during synchronization. Please disable all syncing in the \"Sync Settings\" to unlock.",
        // "obsidianLiveSyncSettingTab.nameTestDatabaseConnection": "Test Database Connection",
        // "obsidianLiveSyncSettingTab.descTestDatabaseConnection": "Open database connection. If the remote database is not found and you have permission to create a database, the database will be created.",
        // "obsidianLiveSyncSettingTab.nameValidateDatabaseConfig": "Validate Database Configuration",
        // "obsidianLiveSyncSettingTab.descValidateDatabaseConfig": "Checks and fixes any potential issues with the database config.",
        // "obsidianLiveSyncSettingTab.btnCheck": "Check",
        // "obsidianLiveSyncSettingTab.titleNotification": "Notification",
        // "obsidianLiveSyncSettingTab.panelPrivacyEncryption": "Privacy & Encryption",
        // "obsidianLiveSyncSettingTab.titleFetchSettings": "Fetch Settings",
        // "obsidianLiveSyncSettingTab.titleFetchConfigFromRemote": "Fetch config from remote server",
        // "obsidianLiveSyncSettingTab.descFetchConfigFromRemote": "Fetch necessary settings from already configured remote server.",
        // "obsidianLiveSyncSettingTab.buttonFetch": "Fetch",
        // "obsidianLiveSyncSettingTab.buttonNext": "Next",
        // "obsidianLiveSyncSettingTab.msgConfigCheckFailed": "The configuration check has failed. Do you want to continue anyway?",
        // "obsidianLiveSyncSettingTab.titleRemoteConfigCheckFailed": "Remote Configuration Check Failed",
        // "obsidianLiveSyncSettingTab.msgEnableEncryptionRecommendation": "We recommend enabling End-To-End Encryption, and Path Obfuscation. Are you sure you want to continue without encryption?",
        // "obsidianLiveSyncSettingTab.titleEncryptionNotEnabled": "Encryption is not enabled",
        // "obsidianLiveSyncSettingTab.msgInvalidPassphrase": "Your encryption passphrase might be invalid. Are you sure you want to continue?",
        // "obsidianLiveSyncSettingTab.titleEncryptionPassphraseInvalid": "Encryption Passphrase Invalid",
        // "obsidianLiveSyncSettingTab.msgFetchConfigFromRemote": "Do you want to fetch the config from the remote server?",
        // "obsidianLiveSyncSettingTab.titleFetchConfig": "Fetch Config",
        // "obsidianLiveSyncSettingTab.titleSyncSettings": "Sync Settings",
        // "obsidianLiveSyncSettingTab.btnGotItAndUpdated": "I got it and updated.",
        // "obsidianLiveSyncSettingTab.msgSelectAndApplyPreset": "Please select and apply any preset item to complete the wizard.",
        // "obsidianLiveSyncSettingTab.titleSynchronizationPreset": "Synchronization Preset",
        // "obsidianLiveSyncSettingTab.optionLiveSync": "LiveSync",
        // "obsidianLiveSyncSettingTab.optionPeriodicWithBatch": "Periodic w/ batch",
        // "obsidianLiveSyncSettingTab.optionDisableAllAutomatic": "Disable all automatic",
        // "obsidianLiveSyncSettingTab.btnApply": "Apply",
        // "obsidianLiveSyncSettingTab.logSelectAnyPreset": "Select any preset.",
        // "obsidianLiveSyncSettingTab.logConfiguredLiveSync": "Configured synchronization mode: LiveSync",
        // "obsidianLiveSyncSettingTab.logConfiguredPeriodic": "Configured synchronization mode: Periodic",
        // "obsidianLiveSyncSettingTab.logConfiguredDisabled": "Configured synchronization mode: DISABLED",
        // "obsidianLiveSyncSettingTab.msgGenerateSetupURI": "All done! Do you want to generate a setup URI to set up other devices?",
        // "obsidianLiveSyncSettingTab.titleCongratulations": "Congratulations!",
        // "obsidianLiveSyncSettingTab.titleSynchronizationMethod": "Synchronization Method",
        // "obsidianLiveSyncSettingTab.optionOnEvents": "On events",
        // "obsidianLiveSyncSettingTab.optionPeriodicAndEvents": "Periodic and on events",
        // "obsidianLiveSyncSettingTab.titleUpdateThinning": "Update Thinning",
        // "obsidianLiveSyncSettingTab.titleDeletionPropagation": "Deletion Propagation",
        // "obsidianLiveSyncSettingTab.titleConflictResolution": "Conflict resolution",
        // "obsidianLiveSyncSettingTab.titleSyncSettingsViaMarkdown": "Sync Settings via Markdown",
        // "obsidianLiveSyncSettingTab.titleHiddenFiles": "Hidden Files",
        // "obsidianLiveSyncSettingTab.labelEnabled": "🔁 : Enabled",
        // "obsidianLiveSyncSettingTab.labelDisabled": "⏹️ : Disabled",
        // "obsidianLiveSyncSettingTab.nameHiddenFileSynchronization": "Hidden file synchronization",
        // "obsidianLiveSyncSettingTab.nameDisableHiddenFileSync": "Disable Hidden files sync",
        // "obsidianLiveSyncSettingTab.btnDisable": "Disable",
        // "obsidianLiveSyncSettingTab.nameEnableHiddenFileSync": "Enable Hidden files sync",
        // "Enable advanced features": "Enable advanced features",
        // "Enable poweruser features": "Enable poweruser features",
        // "Enable edge case treatment features": "Enable edge case treatment features",
        // "lang-de": "Deutsche",
        // "lang-es": "Español",
        // "lang-ja": "日本語",
        // "lang-ru": "Русский",
        // "lang-zh": "简体中文",
        // "lang-zh-tw": "繁體中文",
        "Display Language": "インターフェースの表示言語",
        'Not all messages have been translated. And, please revert to "Default" when reporting errors.':
            'すべてのメッセージが翻訳されているわけではありません。また、Issue報告の際にはいったん"Default"に戻してください',
        "Show status inside the editor": "ステータスをエディタ内に表示",
        // "Requires restart of Obsidian.": "Requires restart of Obsidian.",
        "Show status as icons only": "ステータス表示をアイコンのみにする",
        "Show status on the status bar": "ステータスバーに、ステータスを表示",
        "Show only notifications": "通知のみ表示",
        // "Disables logging, only shows notifications. Please disable if you report an issue.": "Disables logging, only shows notifications. Please disable if you report an issue.",
        "Verbose Log": "エラー以外のログ項目",
        "Show verbose log. Please enable if you report an issue.":
            "エラー以外の詳細ログ項目も表示する。問題が発生した場合は有効にしてください。",
        "Remote Type": "同期方式",
        "Remote server type": "リモートの種別",
        // "Notify when the estimated remote storage size exceeds on start up": "Notify when the estimated remote storage size exceeds on start up",
        // "MB (0 to disable).": "MB (0 to disable).",
        "End-to-End Encryption": "E2E暗号化",
        "Encrypt contents on the remote database. If you use the plugin's synchronization feature, enabling this is recommended.":
            "リモートデータベースの暗号化（オンにすることをお勧めします）",
        Passphrase: "パスフレーズ",
        // "Encryption phassphrase. If changed, you should overwrite the server's database with the new (encrypted) files.": "Encryption phassphrase. If changed, you should overwrite the server's database with the new (encrypted) files.",
        "Path Obfuscation": "パスの難読化",
        "Use dynamic iteration count": "動的な繰り返し回数",
        Presets: "プリセット",
        "Apply preset configuration": "初期設定値に戻す",
        "Sync Mode": "同期モード",
        "Periodic Sync interval": "定時同期の感覚",
        "Interval (sec)": "秒",
        "Sync on Save": "保存時に同期",
        // "Starts synchronisation when a file is saved.": "Starts synchronisation when a file is saved.",
        "Sync on Editor Save": "エディタでの保存時に、同期されます",
        "When you save a file in the editor, start a sync automatically":
            "エディタでファイルを保存すると、自動的に同期を開始します",
        "Sync on File Open": "ファイルを開いた時に同期",
        // "Forces the file to be synced when opened.": "Forces the file to be synced when opened.",
        "Sync on Startup": "起動時同期",
        // "Automatically Sync all files when opening Obsidian.": "Automatically Sync all files when opening Obsidian.",
        "Sync after merging file": "ファイルがマージ(統合)された時に同期",
        // "Sync automatically after merging files": "Sync automatically after merging files",
        "Batch database update": "データベースのバッチ更新",
        // "Reducing the frequency with which on-disk changes are reflected into the DB": "Reducing the frequency with which on-disk changes are reflected into the DB",
        // "Minimum delay for batch database updating": "Minimum delay for batch database updating",
        // "Seconds. Saving to the local database will be delayed until this value after we stop typing or saving.": "Seconds. Saving to the local database will be delayed until this value after we stop typing or saving.",
        // "Maximum delay for batch database updating": "Maximum delay for batch database updating",
        // "Saving will be performed forcefully after this number of seconds.": "Saving will be performed forcefully after this number of seconds.",
        "Use the trash bin": "ゴミ箱を使用",
        // "Move remotely deleted files to the trash, instead of deleting.": "Move remotely deleted files to the trash, instead of deleting.",
        "Keep empty folder": "空フォルダの維持",
        // "Should we keep folders that don't have any files inside?": "Should we keep folders that don't have any files inside?",
        "(BETA) Always overwrite with a newer file": "(ベータ機能) 常に新しいファイルで上書きする",
        // "Testing only - Resolve file conflicts by syncing newer copies of the file, this can overwrite modified files. Be Warned.": "Testing only - Resolve file conflicts by syncing newer copies of the file, this can overwrite modified files. Be Warned.",
        "Delay conflict resolution of inactive files": "無効なファイルは、競合解決を先送りする",
        // "Should we only check for conflicts when a file is opened?": "Should we only check for conflicts when a file is opened?",
        "Delay merge conflict prompt for inactive files.": "手動で無効なファイルの競合を解決する",
        // "Should we prompt you about conflicting files when a file is opened?": "Should we prompt you about conflicting files when a file is opened?",
        Filename: "ファイル名",
        // "Save settings to a markdown file. You will be notified when new settings arrive. You can set different files by the platform.": "Save settings to a markdown file. You will be notified when new settings arrive. You can set different files by the platform.",
        "Write credentials in the file": "クレデンシャルのファイル内保存",
        // "(Not recommended) If set, credentials will be stored in the file.": "(Not recommended) If set, credentials will be stored in the file.",
        "Notify all setting files": "すべての設定を通知",
        // "Suppress notification of hidden files change": "Suppress notification of hidden files change",
        // "If enabled, the notification of hidden files change will be suppressed.": "If enabled, the notification of hidden files change will be suppressed.",
        "Scan for hidden files before replication": "レプリケーション開始前に、隠しファイルのスキャンを行う",
        "Scan hidden files periodically": "定期的に隠しファイルのスキャンを行う",
        // "Seconds, 0 to disable": "Seconds, 0 to disable",
        "Maximum file size": "最大ファイル容量",
        // "(MB) If this is set, changes to local and remote files that are larger than this will be skipped. If the file becomes smaller again, a newer one will be used.": "(MB) If this is set, changes to local and remote files that are larger than this will be skipped. If the file becomes smaller again, a newer one will be used.",
        "(Beta) Use ignore files": "(ベータ機能) 無視ファイル(ignore)の使用",
        // "If this is set, changes to local files which are matched by the ignore files will be skipped. Remote changes are determined using local ignore files.": "If this is set, changes to local files which are matched by the ignore files will be skipped. Remote changes are determined using local ignore files.",
        "Ignore files": "無視ファイル",
        // "Comma separated `.gitignore, .dockerignore`": "Comma separated `.gitignore, .dockerignore`",
        "Device name": "デバイスネーム",
        "Unique name between all synchronized devices. To edit this setting, please disable customization sync once.":
            "一意の名称を、すべての端末に設定します。この設定を変更した場合、カスタマイズ同期機能を無効にしてください。",
        // "Per-file-saved customization sync": "Per-file-saved customization sync",
        // "If enabled per-filed efficient customization sync will be used. We need a small migration when enabling this. And all devices should be updated to v0.23.18. Once we enabled this, we lost a compatibility with old versions.": "If enabled per-filed efficient customization sync will be used. We need a small migration when enabling this. And all devices should be updated to v0.23.18. Once we enabled this, we lost a compatibility with old versions.",
        "Enable customization sync": "カスタマイズ同期を有効",
        "Scan customization automatically": "自動的にカスタマイズをスキャン",
        "Scan customization before replicating.": "レプリケーション前に、カスタマイズをスキャン",
        "Scan customization periodically": "定期的にカスタマイズをスキャン",
        "Scan customization every 1 minute.": "カスタマイズのスキャンを1分ごとに行う",
        "Notify customized": "カスタマイズが行われたら通知する",
        "Notify when other device has newly customized.": "別の端末がカスタマイズを行なったら通知する",
        "Write logs into the file": "ファイルにログを記録",
        // "Warning! This will have a serious impact on performance. And the logs will not be synchronised under the default name. Please be careful with logs; they often contain your confidential information.": "Warning! This will have a serious impact on performance. And the logs will not be synchronised under the default name. Please be careful with logs; they often contain your confidential information.",
        "Suspend file watching": "監視の一時停止",
        "Stop watching for file changes.": "監視の停止",
        "Suspend database reflecting": "データベース反映の一時停止",
        "Stop reflecting database changes to storage files.": "データベースの変更をストレージファイルに反映させない",
        "Memory cache size (by total items)": "全体のキャッシュサイズ",
        "Memory cache size (by total characters)": "全体でキャッシュする文字数",
        // "(Mega chars)": "(Mega chars)",
        "Enhance chunk size": "チャンクサイズを最新にする",
        // "Use splitting-limit-capped chunk splitter": "Use splitting-limit-capped chunk splitter",
        // "If enabled, chunks will be split into no more than 100 items. However, dedupe is slightly weaker.": "If enabled, chunks will be split into no more than 100 items. However, dedupe is slightly weaker.",
        // "Use Segmented-splitter": "Use Segmented-splitter",
        // "If this enabled, chunks will be split into semantically meaningful segments. Not all platforms support this feature.": "If this enabled, chunks will be split into semantically meaningful segments. Not all platforms support this feature.",
        "Fetch chunks on demand": "ユーザーのタイミングでチャンクの更新を確認する",
        // "(ex. Read chunks online) If this option is enabled, LiveSync reads chunks online directly instead of replicating them locally. Increasing Custom chunk size is recommended.": "(ex. Read chunks online) If this option is enabled, LiveSync reads chunks online directly instead of replicating them locally. Increasing Custom chunk size is recommended.",
        // "Batch size of on-demand fetching": "Batch size of on-demand fetching",
        // "The delay for consecutive on-demand fetches": "The delay for consecutive on-demand fetches",
        "Incubate Chunks in Document": "ドキュメント内でハッチングを行う",
        // "If enabled, newly created chunks are temporarily kept within the document, and graduated to become independent chunks once stabilised.": "If enabled, newly created chunks are temporarily kept within the document, and graduated to become independent chunks once stabilised.",
        "Maximum Incubating Chunks": "最大ハッチング数",
        // "The maximum number of chunks that can be incubated within the document. Chunks exceeding this number will immediately graduate to independent chunks.": "The maximum number of chunks that can be incubated within the document. Chunks exceeding this number will immediately graduate to independent chunks.",
        "Maximum Incubating Chunk Size": "保持するチャンクの最大サイズ",
        // "The maximum total size of chunks that can be incubated within the document. Chunks exceeding this size will immediately graduate to independent chunks.": "The maximum total size of chunks that can be incubated within the document. Chunks exceeding this size will immediately graduate to independent chunks.",
        "Maximum Incubation Period": "最大保持期限",
        // "The maximum duration for which chunks can be incubated within the document. Chunks exceeding this period will graduate to independent chunks.": "The maximum duration for which chunks can be incubated within the document. Chunks exceeding this period will graduate to independent chunks.",
        "Data Compression": "データ圧縮",
        "Batch size": "バッチ容量",
        // "Number of changes to sync at a time. Defaults to 50. Minimum is 2.": "Number of changes to sync at a time. Defaults to 50. Minimum is 2.",
        "Batch limit": "バッチの上限",
        "Number of batches to process at a time. Defaults to 40. Minimum is 2. This along with batch size controls how many docs are kept in memory at a time.":
            "1度に処理するバッチの数。デフォルトは40、最小は2。この数値は、どれだけの容量の書類がメモリに保存されるかも定義します。",
        "Use timeouts instead of heartbeats": "ハートビートの代わりにタイムアウトを使用",
        "If this option is enabled, PouchDB will hold the connection open for 60 seconds, and if no change arrives in that time, close and reopen the socket, instead of holding it open indefinitely. Useful when a proxy limits request duration but can increase resource usage.":
            "PouchDBの接続を60秒間維持し、その間に変更がない場合、接続を切断してソケットを再び開きます。プロキシによるリクエスト時間制限があり、なおかつリソースの使用量が増える可能性がある場合に便利です。",
        "Encrypting sensitive configuration items": "機微設定項目の暗号化",
        "Passphrase of sensitive configuration items": "機微設定項目にパスフレーズを使用",
        // "This passphrase will not be copied to another device. It will be set to `Default` until you configure it again.": "This passphrase will not be copied to another device. It will be set to `Default` until you configure it again.",
        // "Enable Developers' Debug Tools.": "Enable Developers' Debug Tools.",
        // "Requires restart of Obsidian": "Requires restart of Obsidian",
        "Do not keep metadata of deleted files.": "削除済みファイルのメタデータを保持しない",
        "Delete old metadata of deleted files on start-up": "削除済みデータのメタデータをクリーンナップする",
        // "(Days passed, 0 to disable automatic-deletion)": "(Days passed, 0 to disable automatic-deletion)",
        "Always prompt merge conflicts": "常に競合は手動で解決する",
        // "Should we prompt you for every single merge, even if we can safely merge automatcially?": "Should we prompt you for every single merge, even if we can safely merge automatcially?",
        "Apply Latest Change if Conflicting": "書類内に競合が発生しても、常に同期内容を反映する",
        // "Enable this option to automatically apply the most recent change to documents even when it conflicts": "Enable this option to automatically apply the most recent change to documents even when it conflicts",
        "(Obsolete) Use an old adapter for compatibility": "古いアダプターを利用（互換性重視）",
        "Before v0.17.16, we used an old adapter for the local database. Now the new adapter is preferred. However, it needs local database rebuilding. Please disable this toggle when you have enough time. If leave it enabled, also while fetching from the remote database, you will be asked to disable this.":
            "v0.17.6までは、古いアダプターをローカル用のデータベースに使用していました。現在は新しいアダプターを推奨しています。しかし、古いデータベースを再構築するためには必要です。有効のままにしておくと、リモートデータベースからフェッチする場合に、この設定を無効にするか質問があります。",
        // "Compute revisions for chunks (Previous behaviour)": "Compute revisions for chunks (Previous behaviour)",
        // "If this enabled, all chunks will be stored with the revision made from its content. (Previous behaviour)": "If this enabled, all chunks will be stored with the revision made from its content. (Previous behaviour)",
        // "Handle files as Case-Sensitive": "Handle files as Case-Sensitive",
        // "If this enabled, All files are handled as case-Sensitive (Previous behaviour).": "If this enabled, All files are handled as case-Sensitive (Previous behaviour).",
        "Scan changes on customization sync": "カスタマイズされた同期時に、変更をスキャンする",
        "Do not use internal API": "内部APIを使用しない",
        "Database suffix": "データベースの接尾詞(サフィックス)",
        "LiveSync could not handle multiple vaults which have same name without different prefix, This should be automatically configured.":
            "LiveSyncは、接頭詞のない同名の保管庫を扱うことができません。この設定は、自動的に設定されます。",
        "The Hash algorithm for chunk IDs": "チャンクIDのハッシュアルゴリズム",
        "Fetch database with previous behaviour": "以前の手法でデータベースを取得",
        // "Do not split chunks in the background": "Do not split chunks in the background",
        // "If disabled(toggled), chunks will be split on the UI thread (Previous behaviour).": "If disabled(toggled), chunks will be split on the UI thread (Previous behaviour).",
        // "Process small files in the foreground": "Process small files in the foreground",
        // "If enabled, the file under 1kb will be processed in the UI thread.": "If enabled, the file under 1kb will be processed in the UI thread.",
        // "Do not check configuration mismatch before replication": "Do not check configuration mismatch before replication",
        "Endpoint URL": "エンドポイントURL",
        "Access Key": "アクセスキー",
        "Secret Key": "シークレットキー",
        Region: "リージョン",
        "Bucket Name": "バケット名",
        "Use Custom HTTP Handler": "カスタムHTTPハンドラーの利用",
        // "Enable this if your Object Storage doesn't support CORS": "Enable this if your Object Storage doesn't support CORS",
        "Server URI": "URI",
        Username: "ユーザー名",
        username: "ユーザー名",
        Password: "パスワード",
        password: "パスワード",
        "Database Name": "データベース名",
        // "logPane.title": "Self-hosted LiveSync Log",
        // "logPane.wrap": "Wrap",
        // "logPane.autoScroll": "Auto scroll",
        // "logPane.pause": "Pause",
        // "logPane.logWindowOpened": "Log window opened",
        // "cmdConfigSync.showCustomizationSync": "Show Customization sync",
        // "moduleObsidianMenu.replicate": "Replicate",
        // "moduleLog.showLog": "Show Log",
        // "liveSyncReplicator.replicationInProgress": "Replication is already in progress",
        // "liveSyncReplicator.oneShotSyncBegin": "OneShot Sync begin... (${syncMode})",
        // "liveSyncReplicator.couldNotConnectToServer": "Could not connect to server.",
        // "liveSyncReplicator.checkingLastSyncPoint": "Looking for the point last synchronized point.",
        // "liveSyncReplicator.cantReplicateLowerValue": "We can't replicate more lower value.",
        // "liveSyncReplicator.retryLowerBatchSize": "Retry with lower batch size:${batch_size}/${batches_limit}",
        // "liveSyncReplicator.beforeLiveSync": "Before LiveSync, start OneShot once...",
        // "liveSyncReplicator.liveSyncBegin": "LiveSync begin...",
        // "liveSyncReplicator.couldNotConnectToRemoteDb": "Could not connect to remote database: ${d}",
        // "liveSyncReplicator.couldNotConnectToURI": "Could not connect to ${uri}:${dbRet}",
        // "liveSyncReplicator.couldNotConnectTo": "Could not connect to ${uri} : ${name} \n\
        // (${db})",
        // "liveSyncReplicator.remoteDbCorrupted": "Remote database is newer or corrupted, make sure to latest version of self-hosted-livesync installed",
        // "liveSyncReplicator.lockRemoteDb": "Lock remote database to prevent data corruption",
        // "liveSyncReplicator.unlockRemoteDb": "Unlock remote database to prevent data corruption",
        // "liveSyncReplicator.replicationClosed": "Replication closed",
        // "liveSyncReplicator.remoteDbDestroyed": "Remote Database Destroyed",
        // "liveSyncReplicator.remoteDbDestroyError": "Something happened on Remote Database Destroy:",
        // "liveSyncReplicator.remoteDbCreatedOrConnected": "Remote Database Created or Connected",
        // "liveSyncReplicator.markDeviceResolved": "Mark this device as 'resolved'.",
        // "liveSyncReplicator.remoteDbMarkedResolved": "Remote database has been marked resolved.",
        // "liveSyncReplicator.couldNotMarkResolveRemoteDb": "Could not mark resolve remote database.",
        // "liveSyncSetting.errorNoSuchSettingItem": "No such setting item: ${key}",
        // "liveSyncSetting.valueShouldBeInRange": "The value should ${min} < value < ${max}",
        // "liveSyncSettings.btnApply": "Apply",
        // "liveSyncSetting.originalValue": "Original: ${value}",
        "dialog.yourLanguageAvailable": `Self-hosted LiveSync にご利用の言語の翻訳がありましたので、%{Display Language}が適用されました。

ご注意： すべてのメッセージは翻訳されていません。あなたのコントリビューションをお待ちしています！
その２： Issueを作成する際には、 %{Display Language} を一旦 %{lang-def} に戻してから、キャプチャやメッセージ、ログを収集してください。これは設定ダイアログから変更できます。

これで便利に使用できれば幸いです。`,
    },
} as const;
