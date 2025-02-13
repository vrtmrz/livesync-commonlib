export const PartialMessages = {
    zh: {
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
        // "moduleLocalDatabase.logWaitingForReady": "Waiting for ready...",
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
        "Display Language": "显示语言",
        'Not all messages have been translated. And, please revert to "Default" when reporting errors.':
            '并非所有消息都已翻译。请在报告错误时恢复为"Default"',
        "Show status inside the editor": "在编辑器内显示状态",
        // "Requires restart of Obsidian.": "Requires restart of Obsidian.",
        "Show status as icons only": "仅以图标显示状态",
        "Show status on the status bar": "在状态栏上显示状态",
        "Show only notifications": "仅显示通知",
        // "Disables logging, only shows notifications. Please disable if you report an issue.": "Disables logging, only shows notifications. Please disable if you report an issue.",
        "Verbose Log": "详细日志",
        // "Show verbose log. Please enable if you report an issue.": "Show verbose log. Please enable if you report an issue.",
        "Remote Type": "远程类型",
        "Remote server type": "远程服务器类型",
        // "Notify when the estimated remote storage size exceeds on start up": "Notify when the estimated remote storage size exceeds on start up",
        // "MB (0 to disable).": "MB (0 to disable).",
        "End-to-End Encryption": "端到端加密",
        "Encrypt contents on the remote database. If you use the plugin's synchronization feature, enabling this is recommended.":
            "加密远程数据库中的内容。如果您使用插件的同步功能，则建议启用此功能。",
        Passphrase: "口令",
        // "Encryption phassphrase. If changed, you should overwrite the server's database with the new (encrypted) files.": "Encryption phassphrase. If changed, you should overwrite the server's database with the new (encrypted) files.",
        "Path Obfuscation": "路径混淆",
        "Use dynamic iteration count": "使用动态迭代次数",
        Presets: "预设",
        "Apply preset configuration": "应用预设配置",
        "Sync Mode": "同步模式",
        "Periodic Sync interval": "定期同步间隔",
        "Interval (sec)": "间隔（秒）",
        "Sync on Save": "保存时同步",
        // "Starts synchronisation when a file is saved.": "Starts synchronisation when a file is saved.",
        "Sync on Editor Save": "编辑器保存时同步",
        // "When you save a file in the editor, start a sync automatically": "When you save a file in the editor, start a sync automatically",
        "Sync on File Open": "打开文件时同步",
        // "Forces the file to be synced when opened.": "Forces the file to be synced when opened.",
        "Sync on Startup": "启动时同步",
        // "Automatically Sync all files when opening Obsidian.": "Automatically Sync all files when opening Obsidian.",
        "Sync after merging file": "合并文件后同步",
        // "Sync automatically after merging files": "Sync automatically after merging files",
        "Batch database update": "批量数据库更新",
        "Reducing the frequency with which on-disk changes are reflected into the DB":
            "降低将磁盘上的更改反映到数据库中的频率",
        "Minimum delay for batch database updating": "批量数据库更新的最小延迟",
        "Seconds. Saving to the local database will be delayed until this value after we stop typing or saving.":
            "秒。在停止输入或保存后，保存到本地数据库将延迟此值。",
        "Maximum delay for batch database updating": "批量数据库更新的最大延迟",
        "Saving will be performed forcefully after this number of seconds.": "在此秒数后将强制执行保存。",
        "Use the trash bin": "使用回收站",
        // "Move remotely deleted files to the trash, instead of deleting.": "Move remotely deleted files to the trash, instead of deleting.",
        "Keep empty folder": "保留空文件夹",
        // "Should we keep folders that don't have any files inside?": "Should we keep folders that don't have any files inside?",
        "(BETA) Always overwrite with a newer file": "始终使用更新的文件覆盖（测试版）",
        // "Testing only - Resolve file conflicts by syncing newer copies of the file, this can overwrite modified files. Be Warned.": "Testing only - Resolve file conflicts by syncing newer copies of the file, this can overwrite modified files. Be Warned.",
        "Delay conflict resolution of inactive files": "推迟解决不活动文件",
        // "Should we only check for conflicts when a file is opened?": "Should we only check for conflicts when a file is opened?",
        "Delay merge conflict prompt for inactive files.": "推迟手动解决不活动文件",
        "Should we prompt you about conflicting files when a file is opened?": "当文件打开时，是否提示冲突文件？",
        Filename: "文件名",
        "Save settings to a markdown file. You will be notified when new settings arrive. You can set different files by the platform.":
            "如果设置了此项，所有设置都将保存在一个Markdown文件中。当新设置到达时，您将收到通知。您可以根据平台设置不同的文件。",
        "Write credentials in the file": "将凭据写入文件",
        "(Not recommended) If set, credentials will be stored in the file.": "（不建议）如果设置，凭据将存储在文件中。",
        "Notify all setting files": "通知所有设置文件",
        // "Suppress notification of hidden files change": "Suppress notification of hidden files change",
        // "If enabled, the notification of hidden files change will be suppressed.": "If enabled, the notification of hidden files change will be suppressed.",
        "Scan for hidden files before replication": "复制前扫描隐藏文件",
        "Scan hidden files periodically": "定期扫描隐藏文件",
        "Seconds, 0 to disable": "秒，0为禁用",
        "Maximum file size": "最大文件大小",
        "(MB) If this is set, changes to local and remote files that are larger than this will be skipped. If the file becomes smaller again, a newer one will be used.":
            "（MB）如果设置了此项，大于此大小的本地和远程文件的更改将被跳过。如果文件再次变小，将使用更新的文件",
        "(Beta) Use ignore files": "（测试版）使用忽略文件",
        "If this is set, changes to local files which are matched by the ignore files will be skipped. Remote changes are determined using local ignore files.":
            "如果设置了此项，与忽略文件匹配的本地文件的更改将被跳过。远程更改使用本地忽略文件确定",
        "Ignore files": "忽略文件",
        "Comma separated `.gitignore, .dockerignore`": "我们可以使用多个忽略文件，例如`.gitignore, .dockerignore`",
        "Device name": "设备名称",
        "Unique name between all synchronized devices. To edit this setting, please disable customization sync once.":
            "所有同步设备之间的唯一名称。要编辑此设置，请首先禁用自定义同步",
        "Per-file-saved customization sync": "按文件保存的自定义同步",
        // "If enabled per-filed efficient customization sync will be used. We need a small migration when enabling this. And all devices should be updated to v0.23.18. Once we enabled this, we lost a compatibility with old versions.": "If enabled per-filed efficient customization sync will be used. We need a small migration when enabling this. And all devices should be updated to v0.23.18. Once we enabled this, we lost a compatibility with old versions.",
        "Enable customization sync": "启用自定义同步",
        "Scan customization automatically": "自动扫描自定义设置",
        "Scan customization before replicating.": "在复制前扫描自定义设置",
        "Scan customization periodically": "定期扫描自定义设置",
        "Scan customization every 1 minute.": "每1分钟扫描自定义设置",
        "Notify customized": "通知自定义设置",
        "Notify when other device has newly customized.": "当其他设备有新的自定义设置时通知",
        "Write logs into the file": "将日志写入文件",
        "Warning! This will have a serious impact on performance. And the logs will not be synchronised under the default name. Please be careful with logs; they often contain your confidential information.":
            "警告！这将严重影响性能。并且日志不会以默认名称同步。请小心处理日志；它们通常包含您的敏感信息",
        "Suspend file watching": "暂停文件监视",
        // "Stop watching for file changes.": "Stop watching for file changes.",
        "Suspend database reflecting": "暂停数据库反映",
        // "Stop reflecting database changes to storage files.": "Stop reflecting database changes to storage files.",
        "Memory cache size (by total items)": "内存缓存大小（按总项目数）",
        "Memory cache size (by total characters)": "内存缓存大小（按总字符数）",
        "(Mega chars)": "（百万字符）",
        "Enhance chunk size": "增强块大小",
        // "Use splitting-limit-capped chunk splitter": "Use splitting-limit-capped chunk splitter",
        // "If enabled, chunks will be split into no more than 100 items. However, dedupe is slightly weaker.": "If enabled, chunks will be split into no more than 100 items. However, dedupe is slightly weaker.",
        // "Use Segmented-splitter": "Use Segmented-splitter",
        // "If this enabled, chunks will be split into semantically meaningful segments. Not all platforms support this feature.": "If this enabled, chunks will be split into semantically meaningful segments. Not all platforms support this feature.",
        "Fetch chunks on demand": "按需获取块",
        "(ex. Read chunks online) If this option is enabled, LiveSync reads chunks online directly instead of replicating them locally. Increasing Custom chunk size is recommended.":
            "（例如，在线读取块）如果启用此选项，LiveSync将直接在线读取块，而不是在本地复制块。建议增加自定义块大小",
        "Batch size of on-demand fetching": "按需获取的批量大小",
        "The delay for consecutive on-demand fetches": "连续按需获取的延迟",
        "Incubate Chunks in Document": "在文档中孵化块",
        "If enabled, newly created chunks are temporarily kept within the document, and graduated to become independent chunks once stabilised.":
            "如果启用，新创建的数据块将暂时保留在文档中，并在稳定后成为独立数据块。",
        "Maximum Incubating Chunks": "最大孵化块数",
        "The maximum number of chunks that can be incubated within the document. Chunks exceeding this number will immediately graduate to independent chunks.":
            "文档中可以孵化的数据块的最大数量。超过此数量的数据块将立即成为独立数据块。",
        "Maximum Incubating Chunk Size": "最大孵化块大小",
        "The maximum total size of chunks that can be incubated within the document. Chunks exceeding this size will immediately graduate to independent chunks.":
            "文档中可以孵化的数据块的最大尺寸。超过此大小的数据块将立即成为独立数据块。",
        "Maximum Incubation Period": "最大孵化期限",
        "The maximum duration for which chunks can be incubated within the document. Chunks exceeding this period will graduate to independent chunks.":
            "文档中可以孵化的数据块的最大持续时间。超过此时间的数据块将成为独立数据块。",
        "Data Compression": "数据压缩",
        "Batch size": "批量大小",
        "Number of changes to sync at a time. Defaults to 50. Minimum is 2.":
            "一次处理的更改源项目数。默认为50。最小为2",
        "Batch limit": "批量限制",
        "Number of batches to process at a time. Defaults to 40. Minimum is 2. This along with batch size controls how many docs are kept in memory at a time.":
            "一次处理的批量数。默认为40。最小为2。这与批量大小一起控制一次在内存中保留多少文档",
        "Use timeouts instead of heartbeats": "使用超时而不是心跳",
        "If this option is enabled, PouchDB will hold the connection open for 60 seconds, and if no change arrives in that time, close and reopen the socket, instead of holding it open indefinitely. Useful when a proxy limits request duration but can increase resource usage.":
            "如果启用此选项，PouchDB将保持连接打开60秒，如果在此时间内没有更改到达，则关闭并重新打开套接字，而不是无限期保持打开。当代理限制请求持续时间时有用，但可能会增加资源使用",
        "Encrypting sensitive configuration items": "加密敏感配置项",
        "Passphrase of sensitive configuration items": "敏感配置项的口令",
        "This passphrase will not be copied to another device. It will be set to `Default` until you configure it again.":
            "此口令不会复制到另一台设备。在您再次配置之前，它将设置为`Default`。",
        // "Enable Developers' Debug Tools.": "Enable Developers' Debug Tools.",
        // "Requires restart of Obsidian": "Requires restart of Obsidian",
        "Do not keep metadata of deleted files.": "不保留已删除文件的元数据",
        "Delete old metadata of deleted files on start-up": "启动时删除已删除文件的旧元数据",
        "(Days passed, 0 to disable automatic-deletion)": "（天数，0为禁用自动删除）",
        "Always prompt merge conflicts": "始终手动解决冲突",
        "Should we prompt you for every single merge, even if we can safely merge automatcially?":
            "如果打开此开关，即使可以自动进行合并，也会显示合并对话框。（打开可恢复到以前的行为）",
        "Apply Latest Change if Conflicting": "即使笔记存在冲突，也始终反映同步的更改",
        "Enable this option to automatically apply the most recent change to documents even when it conflicts":
            "打开可恢复到以前的行为",
        "(Obsolete) Use an old adapter for compatibility": "为了兼容性使用旧适配器",
        "Before v0.17.16, we used an old adapter for the local database. Now the new adapter is preferred. However, it needs local database rebuilding. Please disable this toggle when you have enough time. If leave it enabled, also while fetching from the remote database, you will be asked to disable this.":
            "在v0.17.16之前，我们使用了旧适配器作为本地数据库。现在更倾向于使用新适配器。但是，它需要重建本地数据库。请在有足够时间时禁用此切换。如果保留启用状态，且在从远程数据库获取时，将要求您禁用此切换",
        // "Compute revisions for chunks (Previous behaviour)": "Compute revisions for chunks (Previous behaviour)",
        // "If this enabled, all chunks will be stored with the revision made from its content. (Previous behaviour)": "If this enabled, all chunks will be stored with the revision made from its content. (Previous behaviour)",
        // "Handle files as Case-Sensitive": "Handle files as Case-Sensitive",
        // "If this enabled, All files are handled as case-Sensitive (Previous behaviour).": "If this enabled, All files are handled as case-Sensitive (Previous behaviour).",
        "Scan changes on customization sync": "在自定义同步时扫描更改",
        "Do not use internal API": "不使用内部API",
        "Database suffix": "数据库后缀",
        "LiveSync could not handle multiple vaults which have same name without different prefix, This should be automatically configured.":
            "LiveSync无法处理具有相同名称但没有不同前缀的多个仓库。这应该自动配置",
        "The Hash algorithm for chunk IDs": "块ID的哈希算法",
        "Fetch database with previous behaviour": "用以前的行为获取数据库",
        // "Do not split chunks in the background": "Do not split chunks in the background",
        // "If disabled(toggled), chunks will be split on the UI thread (Previous behaviour).": "If disabled(toggled), chunks will be split on the UI thread (Previous behaviour).",
        "Process small files in the foreground": "处理小文件于前台",
        // "If enabled, the file under 1kb will be processed in the UI thread.": "If enabled, the file under 1kb will be processed in the UI thread.",
        "Do not check configuration mismatch before replication": "在复制前不检查配置不匹配",
        "Endpoint URL": "终端节点网址",
        "Access Key": "访问密钥ID",
        "Secret Key": "访问密钥密码",
        Region: "地域",
        "Bucket Name": "存储桶名称",
        "Use Custom HTTP Handler": "使用自定义HTTP处理程序",
        "Enable this if your Object Storage doesn't support CORS": "如果您的对象存储无法配置接受CORS，请启用此功能。",
        "Server URI": "URI",
        Username: "用户名",
        username: "用户名",
        Password: "密码",
        password: "密码",
        "Database Name": "数据库名称",
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
    },
} as const;
