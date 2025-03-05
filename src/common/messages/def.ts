export const PartialMessages = {
    def: {
        "moduleMigration.logBulkSendCorrupted":
            "Send chunks in bulk has been enabled, however, this feature had been corrupted. Sorry for your inconvenience. Automatically disabled.",
        "moduleMigration.logMigrationFailed": "Migration failed or cancelled from ${old} to ${current}",
        "moduleMigration.logFetchRemoteTweakFailed": "Failed to fetch remote tweak values",
        "moduleMigration.logRemoteTweakUnavailable": "Could not get remote tweak values",
        "moduleMigration.logMigratedSameBehaviour": "Migrated to db:${current} with the same behaviour as before",
        "moduleMigration.logRedflag2CreationFail": "Failed to create redflag2",
        "moduleMigration.logLocalDatabaseNotReady": "Something went wrong! The local database is not ready",
        "moduleMigration.logSetupCancelled":
            "The setup has been cancelled, Self-hosted LiveSync waiting for your setup!",
        "moduleMigration.titleCaseSensitivity": "Case Sensitivity",
        "moduleMigration.msgFetchRemoteAgain":
            "As you may already know, the self-hosted LiveSync has changed its default behaviour and database structure.\n\
\n\
And thankfully, with your time and efforts, the remote database appears to have already been migrated. Congratulations!\n\
\n\
However, we need a bit more. The configuration of this device is not compatible with the remote database. We will need to fetch the remote database again. Should we fetch from the remote again now?\n\
\n\
___Note: We cannot synchronise until the configuration has been changed and the database has been fetched again.___\n\
___Note2: The chunks are completely immutable, we can fetch only the metadata and difference.___",
        "moduleMigration.optionYesFetchAgain": "Yes, fetch again",
        "moduleMigration.optionNoAskAgain": "No, please ask again",
        "moduleMigration.msgSinceV02321":
            "Since v0.23.21, the self-hosted LiveSync has changed the default behaviour and database structure. The following changes have been made:\n\
\n\
1. **Case sensitivity of filenames** \n\
   The handling of filenames is now case-insensitive. This is a beneficial change for most platforms, other than Linux and iOS, which do not manage filename case sensitivity effectively.\n\
   (On These, a warning will be displayed for files with the same name but different cases).\n\
\n\
2. **Revision handling of the chunks** \n\
   Chunks are immutable, which allows their revisions to be fixed. This change will enhance the performance of file saving.\n\
\n\
___However, to enable either of these changes, both remote and local databases need to be rebuilt. This process takes a few minutes, and we recommend doing it when you have ample time.___\n\
\n\
- If you wish to maintain the previous behaviour, you can skip this process by using `${KEEP}`.\n\
- If you do not have enough time, please choose `${DISMISS}`. You will be prompted again later.\n\
- If you have rebuilt the database on another device, please select `${DISMISS}` and try synchronizing again. Since a difference has been detected, you will be prompted again.",
        "moduleMigration.optionEnableBoth": "Enable both",
        "moduleMigration.optionEnableFilenameCaseInsensitive": "Enable only #1",
        "moduleMigration.optionEnableFixedRevisionForChunks": "Enable only #2",
        "moduleMigration.optionAdjustRemote": "Adjust to remote",
        "moduleMigration.optionKeepPreviousBehaviour": "Keep previous behaviour",
        "moduleMigration.optionDecideLater": "Decide it later",
        "moduleMigration.titleWelcome": "Welcome to Self-hosted LiveSync",
        "moduleMigration.msgInitialSetup":
            "Your device has **not been set up yet**. Let me guide you through the setup process.\n\
\n\
Please keep in mind that every dialogue content can be copied to the clipboard. If you need to refer to it later, you can paste it into a note in Obsidian. You can also translate it into your language using a translation tool.\n\
\n\
First, do you have **Setup URI**?\n\
\n\
Note: If you do not know what it is, please refer to the [documentation](${URI_DOC}).",
        "moduleMigration.docUri": "https://github.com/vrtmrz/obsidian-livesync/blob/main/README.md#how-to-use",
        "moduleMigration.optionHaveSetupUri": "Yes, I have",
        "moduleMigration.optionNoSetupUri": "No, I do not have",
        "moduleMigration.titleRecommendSetupUri": "Recommendation to use Setup URI",
        "moduleMigration.msgRecommendSetupUri":
            "We strongly recommend that you generate a set-up URI and use it.\n\
If you do not have knowledge about it, please refer to the [documentation](${URI_DOC}) (Sorry again, but it is important).\n\
\n\
How do you want to set it up manually?",
        "moduleMigration.optionSetupWizard": "Take me into the setup wizard",
        "moduleMigration.optionSetupViaP2P": "Use %{short_p2p_sync} to set up",
        "moduleMigration.optionManualSetup": "Set it up all manually",
        "moduleMigration.optionRemindNextLaunch": "Remind me at the next launch",
        "moduleLocalDatabase.logWaitingForReady": "Waiting for ready...",
        "moduleCheckRemoteSize.logCheckingStorageSizes": "Checking storage sizes",
        "moduleCheckRemoteSize.titleDatabaseSizeNotify": "Setting up database size notification",
        "moduleCheckRemoteSize.msgSetDBCapacity":
            "We can set a maximum database capacity warning, **to take action before running out of space on the remote storage**.\n\
Do you want to enable this?\n\
\n\
> [!MORE]-\n\
> - 0: Do not warn about storage size.\n\
>   This is recommended if you have enough space on the remote storage especially you have self-hosted. And you can check the storage size and rebuild manually.\n\
> - 800: Warn if the remote storage size exceeds 800MB.\n\
>   This is recommended if you are using fly.io with 1GB limit or IBM Cloudant.\n\
> - 2000: Warn if the remote storage size exceeds 2GB.\n\
\n\
If we have reached the limit, we will be asked to enlarge the limit step by step.\n\
",
        "moduleCheckRemoteSize.optionNoWarn": "No, never warn please",
        "moduleCheckRemoteSize.option800MB": "800MB (Cloudant, fly.io)",
        "moduleCheckRemoteSize.option2GB": "2GB (Standard)",
        "moduleCheckRemoteSize.optionAskMeLater": "Ask me later",
        "moduleCheckRemoteSize.titleDatabaseSizeLimitExceeded": "Remote storage size exceeded the limit",
        "moduleCheckRemoteSize.msgDatabaseGrowing":
            "**Your database is getting larger!** But do not worry, we can address it now. The time before running out of space on the remote storage.\n\
\n\
| Measured size | Configured size |\n\
| --- | --- |\n\
| ${estimatedSize} | ${maxSize} |\n\
\n\
> [!MORE]-\n\
> If you have been using it for many years, there may be unreferenced chunks - that is, garbage - accumulating in the database. Therefore, we recommend rebuilding everything. It will probably become much smaller.\n\
> \n\
> If the volume of your vault is simply increasing, it is better to rebuild everything after organizing the files. Self-hosted LiveSync does not delete the actual data even if you delete it to speed up the process. It is roughly [documented](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/tech_info.md).\n\
> \n\
> If you don't mind the increase, you can increase the notification limit by 100MB. This is the case if you are running it on your own server. However, it is better to rebuild everything from time to time.\n\
> \n\
\n\
> [!WARNING]\n\
> If you perform rebuild everything, make sure all devices are synchronised. The plug-in will merge as much as possible, though.\n\
",
        "moduleCheckRemoteSize.optionIncreaseLimit": "increase to ${newMax}MB",
        "moduleCheckRemoteSize.optionRebuildAll": "Rebuild Everything Now",
        "moduleCheckRemoteSize.optionDismiss": "Dismiss",
        "moduleCheckRemoteSize.msgConfirmRebuild":
            "This may take a bit of a long time. Do you really want to rebuild everything now?",
        "moduleCheckRemoteSize.logThresholdEnlarged": "Threshold has been enlarged to ${size}MB",
        "moduleCheckRemoteSize.logExceededWarning": "Remote storage size: ${measuredSize} exceeded ${notifySize}",
        "moduleCheckRemoteSize.logCurrentStorageSize": "Remote storage size: ${measuredSize}",
        "moduleInputUIObsidian.defaultTitleConfirmation": "Confirmation",
        "moduleInputUIObsidian.optionYes": "Yes",
        "moduleInputUIObsidian.optionNo": "No",
        "moduleInputUIObsidian.defaultTitleSelect": "Select",
        "moduleLiveSyncMain.optionKeepLiveSyncDisabled": "Keep LiveSync disabled",
        "moduleLiveSyncMain.optionResumeAndRestart": "Resume and restart Obsidian",
        "moduleLiveSyncMain.msgScramEnabled":
            "Self-hosted LiveSync has been configured to ignore some events. Is this correct?\n\
\n\
| Type | Status | Note |\n\
|:---:|:---:|---|\n\
| Storage Events | ${fileWatchingStatus} | Every modification will be ignored |\n\
| Database Events | ${parseReplicationStatus} | Every synchronised change will be postponed |\n\
\n\
Do you want to resume them and restart Obsidian?\n\
\n\
> [!DETAILS]-\n\
> These flags are set by the plug-in while rebuilding, or fetching. If the process ends abnormally, it may be kept unintended.\n\
> If you are not sure, you can try to rerun these processes. Make sure to back your vault up.\n\
",
        "moduleLiveSyncMain.titleScramEnabled": "Scram Enabled",
        "moduleLiveSyncMain.logAdditionalSafetyScan": "Additional safety scan...",
        "moduleLiveSyncMain.logSafetyScanFailed": "Additional safety scan has failed on a module",
        "moduleLiveSyncMain.logSafetyScanCompleted": "Additional safety scan completed",
        "moduleLiveSyncMain.logLoadingPlugin": "Loading plugin...",
        "moduleLiveSyncMain.logPluginInitCancelled": "Plugin initialisation was cancelled by a module",
        "moduleLiveSyncMain.logPluginVersion": "Self-hosted LiveSync v${manifestVersion} ${packageVersion}",
        "moduleLiveSyncMain.logReadChangelog": "LiveSync has updated, please read the changelog!",
        "moduleLiveSyncMain.logVersionUpdate":
            "LiveSync has been updated, In case of breaking updates, all automatic synchronization has been temporarily disabled. Ensure that all devices are up to date before enabling.",
        "moduleLiveSyncMain.logUnloadingPlugin": "Unloading plugin...",
        "obsidianLiveSyncSettingTab.levelPowerUser": " (Power User)",
        "obsidianLiveSyncSettingTab.levelAdvanced": " (Advanced)",
        "obsidianLiveSyncSettingTab.levelEdgeCase": " (Edge Case)",
        "obsidianLiveSyncSettingTab.logEstimatedSize": "Estimated size: ${size}",
        "obsidianLiveSyncSettingTab.msgSettingModified":
            'The setting "${setting}" was modified from another device. Click {HERE} to reload settings. Click elsewhere to ignore changes.',
        "obsidianLiveSyncSettingTab.optionHere": "HERE",
        "obsidianLiveSyncSettingTab.logPassphraseInvalid": "Passphrase is not valid, please fix it.",
        "obsidianLiveSyncSettingTab.optionFetchFromRemote": "Fetch from Remote",
        "obsidianLiveSyncSettingTab.optionRebuildBoth": "Rebuild Both from This Device",
        "obsidianLiveSyncSettingTab.optionSaveOnlySettings": "(Danger) Save Only Settings",
        "obsidianLiveSyncSettingTab.optionCancel": "Cancel",
        "obsidianLiveSyncSettingTab.titleRebuildRequired": "Rebuild Required",
        "obsidianLiveSyncSettingTab.msgRebuildRequired":
            "Rebuilding Databases are required to apply the changes.. Please select the method to apply the changes.\n\
\n\
<details>\n\
<summary>Legends</summary>\n\
\n\
| Symbol | Meaning |\n\
|: ------ :| ------- |\n\
| ⇔ | Up to Date |\n\
| ⇄ | Synchronise to balance |\n\
| ⇐,⇒ | Transfer to overwrite |\n\
| ⇠,⇢ | Transfer to overwrite from other side |\n\
\n\
</details>\n\
\n\
## ${OPTION_REBUILD_BOTH}\n\
At a glance:  📄 ⇒¹ 💻 ⇒² 🛰️ ⇢ⁿ 💻 ⇄ⁿ⁺¹ 📄\n\
Reconstruct both the local and remote databases using existing files from this device.\n\
This causes a lockout other devices, and they need to perform fetching.\n\
## ${OPTION_FETCH}\n\
At a glance: 📄 ⇄² 💻 ⇐¹ 🛰️ ⇔ 💻 ⇔ 📄\n\
Initialise the local database and reconstruct it using data fetched from the remote database.\n\
This case includes the case which you have rebuilt the remote database.\n\
## ${OPTION_ONLY_SETTING}\n\
Store only the settings. **Caution: This may lead to data corruption**; database reconstruction is generally necessary.",
        "obsidianLiveSyncSettingTab.msgAreYouSureProceed": "Are you sure to proceed?",
        "obsidianLiveSyncSettingTab.msgChangesNeedToBeApplied": "Changes need to be applied!",
        "obsidianLiveSyncSettingTab.optionApply": "Apply",
        "obsidianLiveSyncSettingTab.logCheckPassphraseFailed":
            "ERROR: Failed to check passphrase with the remote server: \n\
${db}.",
        "obsidianLiveSyncSettingTab.logDatabaseConnected": "Database connected",
        "obsidianLiveSyncSettingTab.logPassphraseNotCompatible":
            "ERROR: Passphrase is not compatible with the remote server! Please check it again!",
        "obsidianLiveSyncSettingTab.logEncryptionNoPassphrase": "You cannot enable encryption without a passphrase",
        "obsidianLiveSyncSettingTab.logEncryptionNoSupport": "Your device does not support encryption.",
        "obsidianLiveSyncSettingTab.logRebuildNote": "Syncing has been disabled, fetch and re-enabled if desired.",
        "obsidianLiveSyncSettingTab.panelChangeLog": "Change Log",
        "obsidianLiveSyncSettingTab.msgNewVersionNote":
            "Here due to an upgrade notification? Please review the version history. If you're satisfied, click the button. A new update will prompt this again.",
        "obsidianLiveSyncSettingTab.optionOkReadEverything": "OK, I have read everything.",
        "obsidianLiveSyncSettingTab.panelSetup": "Setup",
        "obsidianLiveSyncSettingTab.titleQuickSetup": "Quick Setup",
        "obsidianLiveSyncSettingTab.nameConnectSetupURI": "Connect with Setup URI",
        "obsidianLiveSyncSettingTab.descConnectSetupURI":
            "This is the recommended method to set up Self-hosted LiveSync with a Setup URI.",
        "obsidianLiveSyncSettingTab.btnUse": "Use",
        "obsidianLiveSyncSettingTab.nameManualSetup": "Manual Setup",
        "obsidianLiveSyncSettingTab.descManualSetup": "Not recommended, but useful if you don't have a Setup URI",
        "obsidianLiveSyncSettingTab.btnStart": "Start",
        "obsidianLiveSyncSettingTab.nameEnableLiveSync": "Enable LiveSync",
        "obsidianLiveSyncSettingTab.descEnableLiveSync":
            "Only enable this after configuring either of the above two options or completing all configuration manually.",
        "obsidianLiveSyncSettingTab.btnEnable": "Enable",
        "obsidianLiveSyncSettingTab.titleSetupOtherDevices": "To setup other devices",
        "obsidianLiveSyncSettingTab.nameCopySetupURI": "Copy the current settings to a Setup URI",
        "obsidianLiveSyncSettingTab.descCopySetupURI": "Perfect for setting up a new device!",
        "obsidianLiveSyncSettingTab.btnCopy": "Copy",
        "obsidianLiveSyncSettingTab.titleReset": "Reset",
        "obsidianLiveSyncSettingTab.nameDiscardSettings": "Discard existing settings and databases",
        "obsidianLiveSyncSettingTab.btnDiscard": "Discard",
        "obsidianLiveSyncSettingTab.msgDiscardConfirmation":
            "Do you really want to discard existing settings and databases?",
        "obsidianLiveSyncSettingTab.titleExtraFeatures": "Enable extra and advanced features",
        "obsidianLiveSyncSettingTab.titleOnlineTips": "Online Tips",
        "obsidianLiveSyncSettingTab.linkTroubleshooting": "/docs/troubleshooting.md",
        "obsidianLiveSyncSettingTab.linkOpenInBrowser": "Open in browser",
        "obsidianLiveSyncSettingTab.logErrorOccurred": "An error occurred!!",
        "obsidianLiveSyncSettingTab.linkTipsAndTroubleshooting": "Tips and Troubleshooting",
        "obsidianLiveSyncSettingTab.linkPageTop": "Page Top",
        "obsidianLiveSyncSettingTab.panelGeneralSettings": "General Settings",
        "obsidianLiveSyncSettingTab.titleAppearance": "Appearance",
        "obsidianLiveSyncSettingTab.defaultLanguage": "Default",
        "obsidianLiveSyncSettingTab.titleLogging": "Logging",
        "obsidianLiveSyncSettingTab.btnNext": "Next",
        "obsidianLiveSyncSettingTab.logCheckingDbConfig": "Checking database configuration",
        "obsidianLiveSyncSettingTab.logCannotUseCloudant": "This feature cannot be used with IBM Cloudant.",
        "obsidianLiveSyncSettingTab.btnFix": "Fix",
        "obsidianLiveSyncSettingTab.logCouchDbConfigSet": "CouchDB Configuration: ${title} -> Set ${key} to ${value}",
        "obsidianLiveSyncSettingTab.logCouchDbConfigUpdated": "CouchDB Configuration: ${title} successfully updated",
        "obsidianLiveSyncSettingTab.logCouchDbConfigFail": "CouchDB Configuration: ${title} failed",
        "obsidianLiveSyncSettingTab.msgNotice": "---Notice---",
        "obsidianLiveSyncSettingTab.msgIfConfigNotPersistent":
            "If the server configuration is not persistent (e.g., running on docker), the values here may change. Once you are able to connect, please update the settings in the server's local.ini.",
        "obsidianLiveSyncSettingTab.msgConfigCheck": "--Config check--",
        "obsidianLiveSyncSettingTab.warnNoAdmin": "⚠ You do not have administrator privileges.",
        "obsidianLiveSyncSettingTab.okAdminPrivileges": "✔ You have administrator privileges.",
        "obsidianLiveSyncSettingTab.errRequireValidUser": "❗ chttpd.require_valid_user is wrong.",
        "obsidianLiveSyncSettingTab.msgSetRequireValidUser": "Set chttpd.require_valid_user = true",
        "obsidianLiveSyncSettingTab.okRequireValidUser": "✔ chttpd.require_valid_user is ok.",
        "obsidianLiveSyncSettingTab.errRequireValidUserAuth": "❗ chttpd_auth.require_valid_user is wrong.",
        "obsidianLiveSyncSettingTab.msgSetRequireValidUserAuth": "Set chttpd_auth.require_valid_user = true",
        "obsidianLiveSyncSettingTab.okRequireValidUserAuth": "✔ chttpd_auth.require_valid_user is ok.",
        "obsidianLiveSyncSettingTab.errMissingWwwAuth": "❗ httpd.WWW-Authenticate is missing",
        "obsidianLiveSyncSettingTab.msgSetWwwAuth": "Set httpd.WWW-Authenticate",
        "obsidianLiveSyncSettingTab.okWwwAuth": "✔ httpd.WWW-Authenticate is ok.",
        "obsidianLiveSyncSettingTab.errEnableCors": "❗ httpd.enable_cors is wrong",
        "obsidianLiveSyncSettingTab.msgEnableCors": "Set httpd.enable_cors",
        "obsidianLiveSyncSettingTab.okEnableCors": "✔ httpd.enable_cors is ok.",
        "obsidianLiveSyncSettingTab.errMaxRequestSize": "❗ chttpd.max_http_request_size is low)",
        "obsidianLiveSyncSettingTab.msgSetMaxRequestSize": "Set chttpd.max_http_request_size",
        "obsidianLiveSyncSettingTab.okMaxRequestSize": "✔ chttpd.max_http_request_size is ok.",
        "obsidianLiveSyncSettingTab.errMaxDocumentSize": "❗ couchdb.max_document_size is low)",
        "obsidianLiveSyncSettingTab.msgSetMaxDocSize": "Set couchdb.max_document_size",
        "obsidianLiveSyncSettingTab.okMaxDocumentSize": "✔ couchdb.max_document_size is ok.",
        "obsidianLiveSyncSettingTab.errCorsCredentials": "❗ cors.credentials is wrong",
        "obsidianLiveSyncSettingTab.msgSetCorsCredentials": "Set cors.credentials",
        "obsidianLiveSyncSettingTab.okCorsCredentials": "✔ cors.credentials is ok.",
        "obsidianLiveSyncSettingTab.okCorsOrigins": "✔ cors.origins is ok.",
        "obsidianLiveSyncSettingTab.errCorsOrigins": "❗ cors.origins is wrong",
        "obsidianLiveSyncSettingTab.msgSetCorsOrigins": "Set cors.origins",
        "obsidianLiveSyncSettingTab.msgConnectionCheck": "--Connection check--",
        "obsidianLiveSyncSettingTab.msgCurrentOrigin": "Current origin: {origin}",
        "obsidianLiveSyncSettingTab.msgOriginCheck": "Origin check: {org}",
        "obsidianLiveSyncSettingTab.errCorsNotAllowingCredentials": "❗ CORS is not allowing credentials",
        "obsidianLiveSyncSettingTab.okCorsCredentialsForOrigin": "CORS credentials OK",
        "obsidianLiveSyncSettingTab.warnCorsOriginUnmatched": "⚠ CORS Origin is unmatched {from}->{to}",
        "obsidianLiveSyncSettingTab.okCorsOriginMatched": "✔ CORS origin OK",
        "obsidianLiveSyncSettingTab.msgDone": "--Done--",
        "obsidianLiveSyncSettingTab.msgConnectionProxyNote":
            "If you're having trouble with the Connection-check (even after checking config), please check your reverse proxy configuration.",
        "obsidianLiveSyncSettingTab.logCheckingConfigDone": "Checking configuration done",
        "obsidianLiveSyncSettingTab.errAccessForbidden": "❗ Access forbidden.",
        "obsidianLiveSyncSettingTab.errCannotContinueTest": "We could not continue the test.",
        "obsidianLiveSyncSettingTab.logCheckingConfigFailed": "Checking configuration failed",
        "obsidianLiveSyncSettingTab.panelRemoteConfiguration": "Remote Configuration",
        "obsidianLiveSyncSettingTab.titleRemoteServer": "Remote Server",
        "obsidianLiveSyncSettingTab.optionCouchDB": "CouchDB",
        "obsidianLiveSyncSettingTab.optionMinioS3R2": "Minio,S3,R2",
        "obsidianLiveSyncSettingTab.titleMinioS3R2": "Minio,S3,R2",
        "obsidianLiveSyncSettingTab.msgObjectStorageWarning":
            "WARNING: This feature is a Work In Progress, so please keep in mind the following:\n\
- Append only architecture. A rebuild is required to shrink the storage.\n\
- A bit fragile.\n\
- When first syncing, all history will be transferred from the remote. Be mindful of data caps and slow speeds.\n\
- Only differences are synced live.\n\
\n\
If you run into any issues, or have ideas about this feature, please create a issue on GitHub.\n\
I appreciate you for your great dedication.",
        "obsidianLiveSyncSettingTab.nameTestConnection": "Test Connection",
        "obsidianLiveSyncSettingTab.btnTest": "Test",
        "obsidianLiveSyncSettingTab.nameApplySettings": "Apply Settings",
        "obsidianLiveSyncSettingTab.titleCouchDB": "CouchDB",
        "obsidianLiveSyncSettingTab.msgNonHTTPSWarning":
            "Cannot connect to non-HTTPS URI. Please update your config and try again.",
        "obsidianLiveSyncSettingTab.msgNonHTTPSInfo":
            "Configured as non-HTTPS URI. Be warned that this may not work on mobile devices.",
        "obsidianLiveSyncSettingTab.msgSettingsUnchangeableDuringSync":
            'These settings are unable to be changed during synchronization. Please disable all syncing in the "Sync Settings" to unlock.',
        "obsidianLiveSyncSettingTab.nameTestDatabaseConnection": "Test Database Connection",
        "obsidianLiveSyncSettingTab.descTestDatabaseConnection":
            "Open database connection. If the remote database is not found and you have permission to create a database, the database will be created.",
        "obsidianLiveSyncSettingTab.nameValidateDatabaseConfig": "Validate Database Configuration",
        "obsidianLiveSyncSettingTab.descValidateDatabaseConfig":
            "Checks and fixes any potential issues with the database config.",
        "obsidianLiveSyncSettingTab.btnCheck": "Check",
        "obsidianLiveSyncSettingTab.titleNotification": "Notification",
        "obsidianLiveSyncSettingTab.panelPrivacyEncryption": "Privacy & Encryption",
        "obsidianLiveSyncSettingTab.titleFetchSettings": "Fetch Settings",
        "obsidianLiveSyncSettingTab.titleFetchConfigFromRemote": "Fetch config from remote server",
        "obsidianLiveSyncSettingTab.descFetchConfigFromRemote":
            "Fetch necessary settings from already configured remote server.",
        "obsidianLiveSyncSettingTab.buttonFetch": "Fetch",
        "obsidianLiveSyncSettingTab.buttonNext": "Next",
        "obsidianLiveSyncSettingTab.msgConfigCheckFailed":
            "The configuration check has failed. Do you want to continue anyway?",
        "obsidianLiveSyncSettingTab.titleRemoteConfigCheckFailed": "Remote Configuration Check Failed",
        "obsidianLiveSyncSettingTab.msgEnableEncryptionRecommendation":
            "We recommend enabling End-To-End Encryption, and Path Obfuscation. Are you sure you want to continue without encryption?",
        "obsidianLiveSyncSettingTab.titleEncryptionNotEnabled": "Encryption is not enabled",
        "obsidianLiveSyncSettingTab.msgInvalidPassphrase":
            "Your encryption passphrase might be invalid. Are you sure you want to continue?",
        "obsidianLiveSyncSettingTab.titleEncryptionPassphraseInvalid": "Encryption Passphrase Invalid",
        "obsidianLiveSyncSettingTab.msgFetchConfigFromRemote":
            "Do you want to fetch the config from the remote server?",
        "obsidianLiveSyncSettingTab.titleFetchConfig": "Fetch Config",
        "obsidianLiveSyncSettingTab.titleSyncSettings": "Sync Settings",
        "obsidianLiveSyncSettingTab.btnGotItAndUpdated": "I got it and updated.",
        "obsidianLiveSyncSettingTab.msgSelectAndApplyPreset":
            "Please select and apply any preset item to complete the wizard.",
        "obsidianLiveSyncSettingTab.titleSynchronizationPreset": "Synchronization Preset",
        "obsidianLiveSyncSettingTab.optionLiveSync": "LiveSync",
        "obsidianLiveSyncSettingTab.optionPeriodicWithBatch": "Periodic w/ batch",
        "obsidianLiveSyncSettingTab.optionDisableAllAutomatic": "Disable all automatic",
        "obsidianLiveSyncSettingTab.btnApply": "Apply",
        "obsidianLiveSyncSettingTab.logSelectAnyPreset": "Select any preset.",
        "obsidianLiveSyncSettingTab.logConfiguredLiveSync": "Configured synchronization mode: LiveSync",
        "obsidianLiveSyncSettingTab.logConfiguredPeriodic": "Configured synchronization mode: Periodic",
        "obsidianLiveSyncSettingTab.logConfiguredDisabled": "Configured synchronization mode: DISABLED",
        "obsidianLiveSyncSettingTab.msgGenerateSetupURI":
            "All done! Do you want to generate a setup URI to set up other devices?",
        "obsidianLiveSyncSettingTab.titleCongratulations": "Congratulations!",
        "obsidianLiveSyncSettingTab.titleSynchronizationMethod": "Synchronization Method",
        "obsidianLiveSyncSettingTab.optionOnEvents": "On events",
        "obsidianLiveSyncSettingTab.optionPeriodicAndEvents": "Periodic and on events",
        "obsidianLiveSyncSettingTab.titleUpdateThinning": "Update Thinning",
        "obsidianLiveSyncSettingTab.titleDeletionPropagation": "Deletion Propagation",
        "obsidianLiveSyncSettingTab.titleConflictResolution": "Conflict resolution",
        "obsidianLiveSyncSettingTab.titleSyncSettingsViaMarkdown": "Sync Settings via Markdown",
        "obsidianLiveSyncSettingTab.titleHiddenFiles": "Hidden Files",
        "obsidianLiveSyncSettingTab.labelEnabled": "🔁 : Enabled",
        "obsidianLiveSyncSettingTab.labelDisabled": "⏹️ : Disabled",
        "obsidianLiveSyncSettingTab.nameHiddenFileSynchronization": "Hidden file synchronization",
        "obsidianLiveSyncSettingTab.nameDisableHiddenFileSync": "Disable Hidden files sync",
        "obsidianLiveSyncSettingTab.btnDisable": "Disable",
        "obsidianLiveSyncSettingTab.nameEnableHiddenFileSync": "Enable Hidden files sync",
        "Enable advanced features": "Enable advanced features",
        "Enable poweruser features": "Enable poweruser features",
        "Enable edge case treatment features": "Enable edge case treatment features",
        "lang-de": "Deutsche",
        "lang-es": "Español",
        "lang-ja": "日本語",
        "lang-ru": "Русский",
        "lang-zh": "简体中文",
        "lang-zh-tw": "繁體中文",
        "Display Language": "Display Language",
        'Not all messages have been translated. And, please revert to "Default" when reporting errors.':
            'Not all messages have been translated. And, please revert to "Default" when reporting errors.',
        "Show status inside the editor": "Show status inside the editor",
        "Requires restart of Obsidian.": "Requires restart of Obsidian.",
        "Show status as icons only": "Show status as icons only",
        "Show status on the status bar": "Show status on the status bar",
        "Show only notifications": "Show only notifications",
        "Disables logging, only shows notifications. Please disable if you report an issue.":
            "Disables logging, only shows notifications. Please disable if you report an issue.",
        "Verbose Log": "Verbose Log",
        "Show verbose log. Please enable if you report an issue.":
            "Show verbose log. Please enable if you report an issue.",
        "Remote Type": "Remote Type",
        "Remote server type": "Remote server type",
        "Notify when the estimated remote storage size exceeds on start up":
            "Notify when the estimated remote storage size exceeds on start up",
        "MB (0 to disable).": "MB (0 to disable).",
        "End-to-End Encryption": "End-to-End Encryption",
        "Encrypt contents on the remote database. If you use the plugin's synchronization feature, enabling this is recommended.":
            "Encrypt contents on the remote database. If you use the plugin's synchronization feature, enabling this is recommended.",
        Passphrase: "Passphrase",
        "Encryption phassphrase. If changed, you should overwrite the server's database with the new (encrypted) files.":
            "Encryption phassphrase. If changed, you should overwrite the server's database with the new (encrypted) files.",
        "Path Obfuscation": "Path Obfuscation",
        "Use dynamic iteration count": "Use dynamic iteration count",
        Presets: "Presets",
        "Apply preset configuration": "Apply preset configuration",
        "Sync Mode": "Sync Mode",
        "Periodic Sync interval": "Periodic Sync interval",
        "Interval (sec)": "Interval (sec)",
        "Sync on Save": "Sync on Save",
        "Starts synchronisation when a file is saved.": "Starts synchronisation when a file is saved.",
        "Sync on Editor Save": "Sync on Editor Save",
        "When you save a file in the editor, start a sync automatically":
            "When you save a file in the editor, start a sync automatically",
        "Sync on File Open": "Sync on File Open",
        "Forces the file to be synced when opened.": "Forces the file to be synced when opened.",
        "Sync on Startup": "Sync on Startup",
        "Automatically Sync all files when opening Obsidian.": "Automatically Sync all files when opening Obsidian.",
        "Sync after merging file": "Sync after merging file",
        "Sync automatically after merging files": "Sync automatically after merging files",
        "Batch database update": "Batch database update",
        "Reducing the frequency with which on-disk changes are reflected into the DB":
            "Reducing the frequency with which on-disk changes are reflected into the DB",
        "Minimum delay for batch database updating": "Minimum delay for batch database updating",
        "Seconds. Saving to the local database will be delayed until this value after we stop typing or saving.":
            "Seconds. Saving to the local database will be delayed until this value after we stop typing or saving.",
        "Maximum delay for batch database updating": "Maximum delay for batch database updating",
        "Saving will be performed forcefully after this number of seconds.":
            "Saving will be performed forcefully after this number of seconds.",
        "Use the trash bin": "Use the trash bin",
        "Move remotely deleted files to the trash, instead of deleting.":
            "Move remotely deleted files to the trash, instead of deleting.",
        "Keep empty folder": "Keep empty folder",
        "Should we keep folders that don't have any files inside?":
            "Should we keep folders that don't have any files inside?",
        "(BETA) Always overwrite with a newer file": "(BETA) Always overwrite with a newer file",
        "Testing only - Resolve file conflicts by syncing newer copies of the file, this can overwrite modified files. Be Warned.":
            "Testing only - Resolve file conflicts by syncing newer copies of the file, this can overwrite modified files. Be Warned.",
        "Delay conflict resolution of inactive files": "Delay conflict resolution of inactive files",
        "Should we only check for conflicts when a file is opened?":
            "Should we only check for conflicts when a file is opened?",
        "Delay merge conflict prompt for inactive files.": "Delay merge conflict prompt for inactive files.",
        "Should we prompt you about conflicting files when a file is opened?":
            "Should we prompt you about conflicting files when a file is opened?",
        Filename: "Filename",
        "Save settings to a markdown file. You will be notified when new settings arrive. You can set different files by the platform.":
            "Save settings to a markdown file. You will be notified when new settings arrive. You can set different files by the platform.",
        "Write credentials in the file": "Write credentials in the file",
        "(Not recommended) If set, credentials will be stored in the file.":
            "(Not recommended) If set, credentials will be stored in the file.",
        "Notify all setting files": "Notify all setting files",
        "Suppress notification of hidden files change": "Suppress notification of hidden files change",
        "If enabled, the notification of hidden files change will be suppressed.":
            "If enabled, the notification of hidden files change will be suppressed.",
        "Scan for hidden files before replication": "Scan for hidden files before replication",
        "Scan hidden files periodically": "Scan hidden files periodically",
        "Seconds, 0 to disable": "Seconds, 0 to disable",
        "Maximum file size": "Maximum file size",
        "(MB) If this is set, changes to local and remote files that are larger than this will be skipped. If the file becomes smaller again, a newer one will be used.":
            "(MB) If this is set, changes to local and remote files that are larger than this will be skipped. If the file becomes smaller again, a newer one will be used.",
        "(Beta) Use ignore files": "(Beta) Use ignore files",
        "If this is set, changes to local files which are matched by the ignore files will be skipped. Remote changes are determined using local ignore files.":
            "If this is set, changes to local files which are matched by the ignore files will be skipped. Remote changes are determined using local ignore files.",
        "Ignore files": "Ignore files",
        "Comma separated `.gitignore, .dockerignore`": "Comma separated `.gitignore, .dockerignore`",
        "Device name": "Device name",
        "Unique name between all synchronized devices. To edit this setting, please disable customization sync once.":
            "Unique name between all synchronized devices. To edit this setting, please disable customization sync once.",
        "Per-file-saved customization sync": "Per-file-saved customization sync",
        "If enabled per-filed efficient customization sync will be used. We need a small migration when enabling this. And all devices should be updated to v0.23.18. Once we enabled this, we lost a compatibility with old versions.":
            "If enabled per-filed efficient customization sync will be used. We need a small migration when enabling this. And all devices should be updated to v0.23.18. Once we enabled this, we lost a compatibility with old versions.",
        "Enable customization sync": "Enable customization sync",
        "K.ScanCustomization": "Scan customization",
        "Scan customization automatically": "Scan customization automatically",
        "Scan customization before replicating.": "Scan customization before replicating.",
        "Scan customization periodically": "Scan customization periodically",
        "Scan customization every 1 minute.": "Scan customization every 1 minute.",
        "Notify customized": "Notify customized",
        "Notify when other device has newly customized.": "Notify when other device has newly customized.",
        "Write logs into the file": "Write logs into the file",
        "Warning! This will have a serious impact on performance. And the logs will not be synchronised under the default name. Please be careful with logs; they often contain your confidential information.":
            "Warning! This will have a serious impact on performance. And the logs will not be synchronised under the default name. Please be careful with logs; they often contain your confidential information.",
        "Suspend file watching": "Suspend file watching",
        "Stop watching for file changes.": "Stop watching for file changes.",
        "Suspend database reflecting": "Suspend database reflecting",
        "Stop reflecting database changes to storage files.": "Stop reflecting database changes to storage files.",
        "Memory cache size (by total items)": "Memory cache size (by total items)",
        "Memory cache size (by total characters)": "Memory cache size (by total characters)",
        "(Mega chars)": "(Mega chars)",
        "Enhance chunk size": "Enhance chunk size",
        "Use splitting-limit-capped chunk splitter": "Use splitting-limit-capped chunk splitter",
        "If enabled, chunks will be split into no more than 100 items. However, dedupe is slightly weaker.":
            "If enabled, chunks will be split into no more than 100 items. However, dedupe is slightly weaker.",
        "Use Segmented-splitter": "Use Segmented-splitter",
        "If this enabled, chunks will be split into semantically meaningful segments. Not all platforms support this feature.":
            "If this enabled, chunks will be split into semantically meaningful segments. Not all platforms support this feature.",
        "Fetch chunks on demand": "Fetch chunks on demand",
        "(ex. Read chunks online) If this option is enabled, LiveSync reads chunks online directly instead of replicating them locally. Increasing Custom chunk size is recommended.":
            "(ex. Read chunks online) If this option is enabled, LiveSync reads chunks online directly instead of replicating them locally. Increasing Custom chunk size is recommended.",
        "Batch size of on-demand fetching": "Batch size of on-demand fetching",
        "The delay for consecutive on-demand fetches": "The delay for consecutive on-demand fetches",
        "Incubate Chunks in Document": "Incubate Chunks in Document",
        "If enabled, newly created chunks are temporarily kept within the document, and graduated to become independent chunks once stabilised.":
            "If enabled, newly created chunks are temporarily kept within the document, and graduated to become independent chunks once stabilised.",
        "Maximum Incubating Chunks": "Maximum Incubating Chunks",
        "The maximum number of chunks that can be incubated within the document. Chunks exceeding this number will immediately graduate to independent chunks.":
            "The maximum number of chunks that can be incubated within the document. Chunks exceeding this number will immediately graduate to independent chunks.",
        "Maximum Incubating Chunk Size": "Maximum Incubating Chunk Size",
        "The maximum total size of chunks that can be incubated within the document. Chunks exceeding this size will immediately graduate to independent chunks.":
            "The maximum total size of chunks that can be incubated within the document. Chunks exceeding this size will immediately graduate to independent chunks.",
        "Maximum Incubation Period": "Maximum Incubation Period",
        "The maximum duration for which chunks can be incubated within the document. Chunks exceeding this period will graduate to independent chunks.":
            "The maximum duration for which chunks can be incubated within the document. Chunks exceeding this period will graduate to independent chunks.",
        "Data Compression": "Data Compression",
        "Batch size": "Batch size",
        "Number of changes to sync at a time. Defaults to 50. Minimum is 2.":
            "Number of changes to sync at a time. Defaults to 50. Minimum is 2.",
        "Batch limit": "Batch limit",
        "Number of batches to process at a time. Defaults to 40. Minimum is 2. This along with batch size controls how many docs are kept in memory at a time.":
            "Number of batches to process at a time. Defaults to 40. Minimum is 2. This along with batch size controls how many docs are kept in memory at a time.",
        "Use timeouts instead of heartbeats": "Use timeouts instead of heartbeats",
        "If this option is enabled, PouchDB will hold the connection open for 60 seconds, and if no change arrives in that time, close and reopen the socket, instead of holding it open indefinitely. Useful when a proxy limits request duration but can increase resource usage.":
            "If this option is enabled, PouchDB will hold the connection open for 60 seconds, and if no change arrives in that time, close and reopen the socket, instead of holding it open indefinitely. Useful when a proxy limits request duration but can increase resource usage.",
        "Encrypting sensitive configuration items": "Encrypting sensitive configuration items",
        "Passphrase of sensitive configuration items": "Passphrase of sensitive configuration items",
        "This passphrase will not be copied to another device. It will be set to `Default` until you configure it again.":
            "This passphrase will not be copied to another device. It will be set to `Default` until you configure it again.",
        "Enable Developers' Debug Tools.": "Enable Developers' Debug Tools.",
        "Requires restart of Obsidian": "Requires restart of Obsidian",
        "Do not keep metadata of deleted files.": "Do not keep metadata of deleted files.",
        "Delete old metadata of deleted files on start-up": "Delete old metadata of deleted files on start-up",
        "(Days passed, 0 to disable automatic-deletion)": "(Days passed, 0 to disable automatic-deletion)",
        "Always prompt merge conflicts": "Always prompt merge conflicts",
        "Should we prompt you for every single merge, even if we can safely merge automatcially?":
            "Should we prompt you for every single merge, even if we can safely merge automatcially?",
        "Apply Latest Change if Conflicting": "Apply Latest Change if Conflicting",
        "Enable this option to automatically apply the most recent change to documents even when it conflicts":
            "Enable this option to automatically apply the most recent change to documents even when it conflicts",
        "(Obsolete) Use an old adapter for compatibility": "(Obsolete) Use an old adapter for compatibility",
        "Before v0.17.16, we used an old adapter for the local database. Now the new adapter is preferred. However, it needs local database rebuilding. Please disable this toggle when you have enough time. If leave it enabled, also while fetching from the remote database, you will be asked to disable this.":
            "Before v0.17.16, we used an old adapter for the local database. Now the new adapter is preferred. However, it needs local database rebuilding. Please disable this toggle when you have enough time. If leave it enabled, also while fetching from the remote database, you will be asked to disable this.",
        "Compute revisions for chunks": "Compute revisions for chunks",
        "If this enabled, all chunks will be stored with the revision made from its content. (Previous behaviour)":
            "If this enabled, all chunks will be stored with the revision made from its content. (Previous behaviour)",
        "Handle files as Case-Sensitive": "Handle files as Case-Sensitive",
        "If this enabled, All files are handled as case-Sensitive (Previous behaviour).":
            "If this enabled, All files are handled as case-Sensitive (Previous behaviour).",
        "Scan changes on customization sync": "Scan changes on customization sync",
        "Do not use internal API": "Do not use internal API",
        "Database suffix": "Database suffix",
        "LiveSync could not handle multiple vaults which have same name without different prefix, This should be automatically configured.":
            "LiveSync could not handle multiple vaults which have same name without different prefix, This should be automatically configured.",
        "The Hash algorithm for chunk IDs": "The Hash algorithm for chunk IDs",
        "Fetch database with previous behaviour": "Fetch database with previous behaviour",
        "Do not split chunks in the background": "Do not split chunks in the background",
        "If disabled(toggled), chunks will be split on the UI thread (Previous behaviour).":
            "If disabled(toggled), chunks will be split on the UI thread (Previous behaviour).",
        "Process small files in the foreground": "Process small files in the foreground",
        "If enabled, the file under 1kb will be processed in the UI thread.":
            "If enabled, the file under 1kb will be processed in the UI thread.",
        "Do not check configuration mismatch before replication":
            "Do not check configuration mismatch before replication",
        "Endpoint URL": "Endpoint URL",
        "Access Key": "Access Key",
        "Secret Key": "Secret Key",
        Region: "Region",
        "Bucket Name": "Bucket Name",
        "Use Custom HTTP Handler": "Use Custom HTTP Handler",
        "Enable this if your Object Storage doesn't support CORS":
            "Enable this if your Object Storage doesn't support CORS",
        "Server URI": "Server URI",
        Username: "Username",
        username: "username",
        Password: "Password",
        password: "password",
        "Database Name": "Database Name",
        "logPane.title": "Self-hosted LiveSync Log",
        "logPane.wrap": "Wrap",
        "logPane.autoScroll": "Auto scroll",
        "logPane.pause": "Pause",
        "logPane.logWindowOpened": "Log window opened",
        "cmdConfigSync.showCustomizationSync": "Show Customization sync",
        "moduleObsidianMenu.replicate": "Replicate",
        "moduleLog.showLog": "Show Log",
        "liveSyncReplicator.replicationInProgress": "Replication is already in progress",
        "liveSyncReplicator.oneShotSyncBegin": "OneShot Sync begin... (${syncMode})",
        "liveSyncReplicator.couldNotConnectToServer": "Could not connect to server.",
        "liveSyncReplicator.checkingLastSyncPoint": "Looking for the point last synchronized point.",
        "liveSyncReplicator.cantReplicateLowerValue": "We can't replicate more lower value.",
        "liveSyncReplicator.retryLowerBatchSize": "Retry with lower batch size:${batch_size}/${batches_limit}",
        "liveSyncReplicator.beforeLiveSync": "Before LiveSync, start OneShot once...",
        "liveSyncReplicator.liveSyncBegin": "LiveSync begin...",
        "liveSyncReplicator.couldNotConnectToRemoteDb": "Could not connect to remote database: ${d}",
        "liveSyncReplicator.couldNotConnectToURI": "Could not connect to ${uri}:${dbRet}",
        "liveSyncReplicator.couldNotConnectTo":
            "Could not connect to ${uri} : ${name} \n\
(${db})",
        "liveSyncReplicator.remoteDbCorrupted":
            "Remote database is newer or corrupted, make sure to latest version of self-hosted-livesync installed",
        "liveSyncReplicator.lockRemoteDb": "Lock remote database to prevent data corruption",
        "liveSyncReplicator.unlockRemoteDb": "Unlock remote database to prevent data corruption",
        "liveSyncReplicator.replicationClosed": "Replication closed",
        "liveSyncReplicator.remoteDbDestroyed": "Remote Database Destroyed",
        "liveSyncReplicator.remoteDbDestroyError": "Something happened on Remote Database Destroy:",
        "liveSyncReplicator.remoteDbCreatedOrConnected": "Remote Database Created or Connected",
        "liveSyncReplicator.markDeviceResolved": "Mark this device as 'resolved'.",
        "liveSyncReplicator.remoteDbMarkedResolved": "Remote database has been marked resolved.",
        "liveSyncReplicator.couldNotMarkResolveRemoteDb": "Could not mark resolve remote database.",
        "liveSyncSetting.errorNoSuchSettingItem": "No such setting item: ${key}",
        "liveSyncSetting.valueShouldBeInRange": "The value should ${min} < value < ${max}",
        "liveSyncSettings.btnApply": "Apply",
        "liveSyncSetting.originalValue": "Original: ${value}",
        "K.Peer": "Peer",
        "K.P2P": "%{Peer}-to-%{Peer}",
        "P2P.P2PReplication": "%{P2P} Replication",
        "K.exp": "Experimental",
        "K.short_p2p_sync": "P2P Sync (%{exp})",
        "K.title_p2p_sync": "Peer-to-Peer Sync",
        "K.long_p2p_sync": "%{title_p2p_sync} (%{exp})",
        "P2P.PaneTitle": "%{long_p2p_sync}",
        "P2P.NotEnabled": "%{title_p2p_sync} is not enabled. We cannot open a new connection.",
        "P2P.NoAutoSyncPeers": "No auto-sync peers found. Please set peers on the %{long_p2p_sync} pane.",
        "P2P.FailedToOpen": "Failed to open P2P connection to the signaling server.",
        "P2P.SyncCompleted": "P2P Sync completed.",
        "P2P.SeemsOffline": "Peer ${name} seems offline, skipped.",
        "P2P.SyncStartedWith": "P2P Sync with ${name} have been started.",
        "P2P.ReplicatorInstanceMissing":
            "P2P Sync replicator is not found, possibly not have been configured or enabled.",
        "P2P.SyncAlreadyRunning": "P2P Sync is already running.",
        "P2P.Note.Summary": "What is this  feature? (and some important notes, please read once)",
        "P2P.Note.important_note": "The Experimental Implementation of the Peer-to-Peer Replicator.",
        "P2P.Note.important_note_sub":
            "This feature is still in the experimental stage. Please be aware that this feature may not work as expected. Furthermore, it may have some bugs, security issues, and other issues. Please use this feature at your own risk. Please contribute to the development of this feature.",
        "P2P.Note.description":
            " This replicator allows us to synchronise our vault with other devices using a peer-to-peer connection. We can\
        use this to synchronise our vault with our other devices without using a cloud service.\
\n\n\
This replicator is based on Trystero. It also uses a signaling server to establish a connection between devices. The signaling server is used to exchange connection information between devices. It does (or,should) not know or store any of our data.\
\n\n\
The signaling server can be hosted by anyone. This is just a Nostr relay. For the sake of simplicity and checking the behaviour of the replicator, an instance of the signaling server is hosted by vrtmrz. You can use the experimental server provided by vrtmrz, or you can use any other server.\
\n\n\
By the way, even if the signaling server does not store our data, it can see the connection information of some of our devices. Please be aware of this. Also, be cautious when using the server provided by someone else.\
",
        "P2P.NoKnownPeers": "No peers has been detected, waiting incoming other peers...",
        "P2P.DisabledButNeed": "%{title_p2p_sync} is disabled. Do you really want to enable it?",
        "P2P.AskPassphraseForDecrypt":
            "The remote peer shared the configuration. Please input the passphrase to decrypt the configuration.",
        "P2P.AskPassphraseForShare":
            "The remote peer requested this device configuration. Please input the passphrase to share the configuration. You can ignore the request by cancelling this dialogue.",
        "Doctor.Dialogue.Title": "Self-hosted LiveSync Config Doctor",
        "Doctor.Dialogue.Main": `Hi! Config Doctor has been activated because of \${activateReason}!
And, unfortunately some configurations were detected as potential problems.
Please be assured. Let's solve them one by one.

To let you know ahead of time, we will ask you about the following items.

\${issues}

Shall we get started?`,
        "Doctor.Dialogue.TitleFix": "Fix issue ${current}/${total}",
        "Doctor.Dialogue.MainFix": `**Configuration name:** \`\${name}\`
**Current value:** \`\${current}\`, **Ideal value:** \`\${ideal}\`
**Recommendation Level:** \${level}
**Why this has been detected?**
\${reason}


\${note}

Fix this to the ideal value?`,
        "Doctor.Message.RebuildRequired": "Attention! A rebuild is required to apply this!",
        "Doctor.Message.RebuildLocalRequired": "Attention! A local database rebuild is required to apply this!",
        "Doctor.Message.SomeSkipped": "We left some issues as is. Shall I ask you again on next startup?",
        "Doctor.Dialogue.TitleAlmostDone": "Almost done!",
        "Doctor.Level.Necessary": "Necessary",
        "Doctor.Level.Recommended": "Recommended",
        "Doctor.Level.Optional": "Optional",
        "Doctor.Level.Must": "Must",
        "Doctor.Button.Fix": "Fix it",
        "Doctor.Button.FixButNoRebuild": "Fix it but no rebuild",
        "Doctor.Button.Skip": "Leave it as is",
        "Doctor.Button.Yes": "Yes",
        "Doctor.Button.No": "No",
        "Doctor.Button.DismissThisVersion": "No, and do not ask again until the next release",
        "Doctor.Message.NoIssues": "No issues detected!",
        "Setting.TroubleShooting": "TroubleShooting",
        "Setting.TroubleShooting.Doctor": "Setting Doctor",
        "Setting.TroubleShooting.Doctor.Desc": "Detects non optimal settings. (Same as during migration)",
        "TweakMismatchResolve.Table": `| Value name | This device | On Remote |
|: --- |: ---- :|: ---- :|
\${rows}

`,
        "TweakMismatchResolve.Table.Row": `| \${name} | \${self} | \${remote} |`,
        "TweakMismatchResolve.Message.UseRemote.WarningRebuildRequired": `
>[!WARNING]
> Some remote configurations are not compatible with the local database of this device. Rebuilding the local database will be required.
> ***Please ensure that you have time and are connected to a stable network to apply!***`,
        "TweakMismatchResolve.Message.UseRemote.WarningRebuildRecommended": `
>[!NOTICE]
> Some changes are compatible but may consume extra storage and transfer volumes. A rebuild is recommended. However, a rebuild may not be performed at present, but may be implemented in future maintenance.
> ***Please ensure that you have time and are connected to a stable network to apply!***`,
        "TweakMismatchResolve.Message.Main": `
The settings in the remote database are as follows. These values are configured by other devices, which are synchronised with this device at least once.

If you want to use these settings, please select %{TweakMismatchResolve.Action.UseConfigured}.
If you want to keep the settings of this device, please select %{TweakMismatchResolve.Action.Dismiss}.

\${table}

>[!TIP]
> If you want to synchronise all settings, please use \`Sync settings via markdown\` after applying minimal configuration with this feature.

\${additionalMessage}`,
        "TweakMismatchResolve.Action.UseRemote": `Apply settings to this device`,
        "TweakMismatchResolve.Action.UseRemoteWithRebuild": `Apply settings to this device, and fetch again`,
        "TweakMismatchResolve.Action.UseRemoteAcceptIncompatible": `Apply settings to this device, but and ignore incompatibility`,
        "TweakMismatchResolve.Action.UseMine": `Update remote database settings`,
        "TweakMismatchResolve.Action.UseMineWithRebuild": `Update remote database settings and rebuild again`,
        "TweakMismatchResolve.Action.UseMineAcceptIncompatible": `Update remote database settings but keep as is`,
        "TweakMismatchResolve.Action.UseConfigured": `Use configured settings`,
        "TweakMismatchResolve.Action.Dismiss": `Dismiss`,
        "TweakMismatchResolve.Message.WarningIncompatibleRebuildRequired": `
>[!WARNING]
> We have detected that some of the values are different to make incompatible the local database with the remote database.
> Either local or remote rebuilds are required. Both of them takes a few minutes or more. **Make sure it is safe to perform it now.**`,
        "TweakMismatchResolve.Message.WarningIncompatibleRebuildRecommended": `
>[!NOTICE]
> We have detected that some of the values are different to make incompatible the local database with the remote database.
> Some changes are compatible but may consume extra storage and transfer volumes. A rebuild is recommended. However, a rebuild may not be performed at present, but may be implemented in future maintenance.
> If you want to rebuild, it takes a few minutes or more. **Make sure it is safe to perform it now.**`,
        "TweakMismatchResolve.Message.MainTweakResolving": `Your configuration has not been matched with the one on the remote server.

Following configuration should be matched:

\${table}

Let us know your decision.

\${additionalMessage}`,
        "TweakMismatchResolve.Title": "Configuration Mismatch Detected",
        "TweakMismatchResolve.Title.TweakResolving": "Configuration Mismatch Detected",
        "TweakMismatchResolve.Title.UseRemoteConfig": "Use Remote Configuration",
        "Replicator.Dialogue.Locked.Title": "Locked",
        "Replicator.Dialogue.Locked.Message": `Remote database is locked. This is due to a rebuild on one of the terminals.
The device is therefore asked to withhold the connection to avoid database corruption.

There are three options that we can do:

- %{Replicator.Dialogue.Locked.Action.Fetch}
  The most preferred and reliable way. This will dispose the local database once, and fetch all from the remote database again, In most case, we can perform this safely. However, it takes some time and should be done in stable network.
- %{Replicator.Dialogue.Locked.Action.Unlock}
  This method can only be used if we are already reliably synchronised by other replication methods. This does not simply mean that we have the same files. If you are not sure, you should avoid it.
- %{Replicator.Dialogue.Locked.Action.Dismiss}
    This will cancel the operation. And we will asked again on next request.
`,
        "Replicator.Dialogue.Locked.Action.Fetch": "Fetch all from the remote database again",
        "Replicator.Dialogue.Locked.Action.Unlock": "Unlock the remote database",
        "Replicator.Dialogue.Locked.Action.Dismiss": "Cancel for reconfirmation",
        "Replicator.Dialogue.Locked.Message.Fetch":
            "Fetch all has been scheduled. Plug-in will be restarted to perform it.",
        "Replicator.Dialogue.Locked.Message.Unlocked":
            "The remote database has been unlocked. Please retry the operation.",
        "Replicator.Message.Cleaned": "Database cleaning up is in process. replication has been cancelled",
        "Replicator.Message.VersionUpFlash": "Open settings and check message, please. replication has been cancelled.",
        "Replicator.Message.Pending": "Some file events are pending. Replication has been cancelled.",
        "Replicator.Message.SomeModuleFailed": `Replication has been cancelled by some module failure`,
        "Replicator.Message.InitialiseFatalError": "No replicator is available, this is the fatal error.",
        "SettingTab.Message.AskRebuild": `Your changes require fetching from the remote database. Do you want to proceed?`,
        "Setup.QRCode": `We have generated a QR code to transfer the settings. Please scan the QR code with your phone or other device.
Note: The QR code is not encrypted, so be careful to open this.

>[!FOR YOUR EYES ONLY]-
> <div class="sls-qr">\${qr_image}</div>`,
    },
} as const;
