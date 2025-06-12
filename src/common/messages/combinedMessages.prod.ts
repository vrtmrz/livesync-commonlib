export const _allMessages = {
    "moduleMigration.logBulkSendCorrupted": {
        def: "Send chunks in bulk has been enabled, however, this feature had been corrupted. Sorry for your inconvenience. Automatically disabled.",
        es: "El envío de fragmentos en bloque se ha habilitado, sin embargo, esta función se ha corrompido. Disculpe las molestias. Deshabilitado automáticamente.",
    },
    "moduleMigration.logMigrationFailed": {
        def: "Migration failed or cancelled from ${old} to ${current}",
        es: "La migración falló o se canceló de ${old} a ${current}",
    },
    "moduleMigration.logFetchRemoteTweakFailed": {
        def: "Failed to fetch remote tweak values",
        es: "Error al obtener los valores de ajuste remoto",
    },
    "moduleMigration.logRemoteTweakUnavailable": {
        def: "Could not get remote tweak values",
        es: "No se pudieron obtener los valores de ajuste remoto",
    },
    "moduleMigration.logMigratedSameBehaviour": {
        def: "Migrated to db:${current} with the same behaviour as before",
        es: "Migrado a db:${current} con el mismo comportamiento que antes",
    },
    "moduleMigration.logRedflag2CreationFail": {
        def: "Failed to create redflag2",
        es: "Error al crear redflag2",
    },
    "moduleMigration.logLocalDatabaseNotReady": {
        def: "Something went wrong! The local database is not ready",
        es: "¡Algo salió mal! La base de datos local no está lista",
    },
    "moduleMigration.logSetupCancelled": {
        def: "The setup has been cancelled, Self-hosted LiveSync waiting for your setup!",
        es: "La configuración ha sido cancelada, ¡Self-hosted LiveSync está esperando tu configuración!",
    },
    "moduleMigration.titleCaseSensitivity": {
        def: "Case Sensitivity",
        es: "Sensibilidad a mayúsculas",
    },
    "moduleMigration.msgFetchRemoteAgain": {
        def: "As you may already know, the self-hosted LiveSync has changed its default behaviour and database structure.\n\nAnd thankfully, with your time and efforts, the remote database appears to have already been migrated. Congratulations!\n\nHowever, we need a bit more. The configuration of this device is not compatible with the remote database. We will need to fetch the remote database again. Should we fetch from the remote again now?\n\n___Note: We cannot synchronise until the configuration has been changed and the database has been fetched again.___\n___Note2: The chunks are completely immutable, we can fetch only the metadata and difference.___",
        es: "Como ya sabrás, Self-hosted LiveSync ha cambiado su comportamiento predeterminado y la estructura de la base de datos.\n\nAfortunadamente, con tu tiempo y esfuerzo, la base de datos remota parece haber sido ya migrada. ¡Felicidades!\n\nSin embargo, necesitamos un poco más. La configuración de este dispositivo no es compatible con la base de datos remota. Necesitaremos volver a obtener la base de datos remota. ¿Debemos obtenerla nuevamente ahora?\n\n___Nota: No podemos sincronizar hasta que la configuración haya sido cambiada y la base de datos haya sido obtenida nuevamente.___\n___Nota2: Los fragmentos son completamente inmutables, solo podemos obtener los metadatos y diferencias.___",
    },
    "moduleMigration.optionYesFetchAgain": {
        def: "Yes, fetch again",
        es: "Sí, obtener nuevamente",
    },
    "moduleMigration.optionNoAskAgain": {
        def: "No, please ask again",
        es: "No, por favor pregúntame de nuevo",
    },
    "moduleMigration.msgSinceV02321": {
        def: "Since v0.23.21, the self-hosted LiveSync has changed the default behaviour and database structure. The following changes have been made:\n\n1. **Case sensitivity of filenames** \n   The handling of filenames is now case-insensitive. This is a beneficial change for most platforms, other than Linux and iOS, which do not manage filename case sensitivity effectively.\n   (On These, a warning will be displayed for files with the same name but different cases).\n\n2. **Revision handling of the chunks** \n   Chunks are immutable, which allows their revisions to be fixed. This change will enhance the performance of file saving.\n\n___However, to enable either of these changes, both remote and local databases need to be rebuilt. This process takes a few minutes, and we recommend doing it when you have ample time.___\n\n- If you wish to maintain the previous behaviour, you can skip this process by using `${KEEP}`.\n- If you do not have enough time, please choose `${DISMISS}`. You will be prompted again later.\n- If you have rebuilt the database on another device, please select `${DISMISS}` and try synchronizing again. Since a difference has been detected, you will be prompted again.",
        es: "Desde la versión v0.23.21, Self-hosted LiveSync ha cambiado el comportamiento predeterminado y la estructura de la base de datos. Se han realizado los siguientes cambios:\n\n1. **Sensibilidad a mayúsculas de los nombres de archivo**\n    El manejo de los nombres de archivo ahora no distingue entre mayúsculas y minúsculas. Este cambio es beneficioso para la mayoría de las plataformas, excepto Linux y iOS, que no gestionan efectivamente la sensibilidad a mayúsculas de los nombres de archivo.\n    (En estos, se mostrará una advertencia para archivos con el mismo nombre pero diferentes mayúsculas).\n\n2. **Manejo de revisiones de los fragmentos**\n    Los fragmentos son inmutables, lo que permite que sus revisiones sean fijas. Este cambio mejorará el rendimiento al guardar archivos.\n\n___Sin embargo, para habilitar cualquiera de estos cambios, es necesario reconstruir tanto las bases de datos remota como la local. Este proceso toma unos minutos, y recomendamos hacerlo cuando tengas tiempo suficiente.___\n\n- Si deseas mantener el comportamiento anterior, puedes omitir este proceso usando `${KEEP}`.\n- Si no tienes suficiente tiempo, por favor elige `${DISMISS}`. Se te pedirá nuevamente más tarde.\n- Si has reconstruido la base de datos en otro dispositivo, selecciona `${DISMISS}` e intenta sincronizar nuevamente. Dado que se ha detectado una diferencia, se te solicitará nuevamente.",
    },
    "moduleMigration.optionEnableBoth": {
        def: "Enable both",
        es: "Habilitar ambos",
    },
    "moduleMigration.optionEnableFilenameCaseInsensitive": {
        def: "Enable only #1",
        es: "Habilitar solo #1",
    },
    "moduleMigration.optionEnableFixedRevisionForChunks": {
        def: "Enable only #2",
        es: "Habilitar solo #2",
    },
    "moduleMigration.optionAdjustRemote": {
        def: "Adjust to remote",
        es: "Ajustar al remoto",
    },
    "moduleMigration.optionKeepPreviousBehaviour": {
        def: "Keep previous behaviour",
        es: "Mantener comportamiento anterior",
    },
    "moduleMigration.optionDecideLater": {
        def: "Decide it later",
        es: "Decidirlo más tarde",
    },
    "moduleMigration.titleWelcome": {
        def: "Welcome to Self-hosted LiveSync",
        es: "Bienvenido a Self-hosted LiveSync",
    },
    "moduleMigration.msgInitialSetup": {
        def: "Your device has **not been set up yet**. Let me guide you through the setup process.\n\nPlease keep in mind that every dialogue content can be copied to the clipboard. If you need to refer to it later, you can paste it into a note in Obsidian. You can also translate it into your language using a translation tool.\n\nFirst, do you have **Setup URI**?\n\nNote: If you do not know what it is, please refer to the [documentation](${URI_DOC}).",
        es: "Tu dispositivo **aún no ha sido configurado**. Permíteme guiarte a través del proceso de configuración.\n\nTen en cuenta que todo el contenido del diálogo se puede copiar al portapapeles. Si necesitas consultarlo más tarde, puedes pegarlo en una nota en Obsidian. También puedes traducirlo a tu idioma utilizando una herramienta de traducción.\n\nPrimero, ¿tienes **URI de configuración**?\n\nNota: Si no sabes qué es, consulta la [documentación](${URI_DOC}).",
    },
    "moduleMigration.docUri": {
        def: "https://github.com/vrtmrz/obsidian-livesync/blob/main/README.md#how-to-use",
        es: "https://github.com/vrtmrz/obsidian-livesync/blob/main/README_ES.md#how-to-use",
    },
    "moduleMigration.optionHaveSetupUri": {
        def: "Yes, I have",
        es: "Sí, tengo",
    },
    "moduleMigration.optionNoSetupUri": {
        def: "No, I do not have",
        es: "No, no tengo",
    },
    "moduleMigration.titleRecommendSetupUri": {
        def: "Recommendation to use Setup URI",
        es: "Recomendación de uso de URI de configuración",
    },
    "moduleMigration.msgRecommendSetupUri": {
        def: "We strongly recommend that you generate a set-up URI and use it.\nIf you do not have knowledge about it, please refer to the [documentation](${URI_DOC}) (Sorry again, but it is important).\n\nHow do you want to set it up manually?",
        es: "Te recomendamos encarecidamente que generes una URI de configuración y la utilices.\nSi no tienes conocimientos al respecto, consulta la [documentación](${URI_DOC}) (Lo siento de nuevo, pero es importante).\n\n¿Cómo quieres configurarlo manualmente?",
    },
    "moduleMigration.optionSetupWizard": {
        def: "Take me into the setup wizard",
        es: "Llévame al asistente de configuración",
    },
    "moduleMigration.optionSetupViaP2P": {
        def: "Use %{short_p2p_sync} to set up",
    },
    "moduleMigration.optionManualSetup": {
        def: "Set it up all manually",
        es: "Configurarlo todo manualmente",
    },
    "moduleMigration.optionRemindNextLaunch": {
        def: "Remind me at the next launch",
        es: "Recordármelo en el próximo inicio",
    },
    "moduleLocalDatabase.logWaitingForReady": {
        def: "Waiting for ready...",
        es: "Esperando a que la base de datos esté lista...",
        ja: "しばらくお待ちください...",
    },
    "moduleCheckRemoteSize.logCheckingStorageSizes": {
        def: "Checking storage sizes",
        es: "Comprobando tamaños de almacenamiento",
    },
    "moduleCheckRemoteSize.titleDatabaseSizeNotify": {
        def: "Setting up database size notification",
        es: "Configuración de notificación de tamaño de base de datos",
    },
    "moduleCheckRemoteSize.msgSetDBCapacity": {
        def: "We can set a maximum database capacity warning, **to take action before running out of space on the remote storage**.\nDo you want to enable this?\n\n> [!MORE]-\n> - 0: Do not warn about storage size.\n>   This is recommended if you have enough space on the remote storage especially you have self-hosted. And you can check the storage size and rebuild manually.\n> - 800: Warn if the remote storage size exceeds 800MB.\n>   This is recommended if you are using fly.io with 1GB limit or IBM Cloudant.\n> - 2000: Warn if the remote storage size exceeds 2GB.\n\nIf we have reached the limit, we will be asked to enlarge the limit step by step.\n",
        es: "Podemos configurar una advertencia de capacidad máxima de base de datos, **para tomar medidas antes de quedarse sin espacio en el almacenamiento remoto**.\n¿Quieres habilitar esto?\n\n> [!MORE]-\n> - 0: No advertir sobre el tamaño del almacenamiento.\n>   Esto es recomendado si tienes suficiente espacio en el almacenamiento remoto, especialmente si lo tienes autoalojado. Y puedes comprobar el tamaño del almacenamiento y reconstruir manualmente.\n> - 800: Advertir si el tamaño del almacenamiento remoto supera los 800 MB.\n>   Esto es recomendado si estás usando fly.io con un límite de 1 GB o IBM Cloudant.\n> - 2000: Advertir si el tamaño del almacenamiento remoto supera los 2 GB.\n\nSi hemos alcanzado el límite, se nos pedirá que aumentemos el límite paso a paso.\n",
    },
    "moduleCheckRemoteSize.optionNoWarn": {
        def: "No, never warn please",
        es: "No, nunca advertir por favor",
    },
    "moduleCheckRemoteSize.option800MB": {
        def: "800MB (Cloudant, fly.io)",
        es: "800MB (Cloudant, fly.io)",
    },
    "moduleCheckRemoteSize.option2GB": {
        def: "2GB (Standard)",
        es: "2GB (Estándar)",
    },
    "moduleCheckRemoteSize.optionAskMeLater": {
        def: "Ask me later",
        es: "Pregúntame más tarde",
    },
    "moduleCheckRemoteSize.titleDatabaseSizeLimitExceeded": {
        def: "Remote storage size exceeded the limit",
        es: "El tamaño del almacenamiento remoto superó el límite",
    },
    "moduleCheckRemoteSize.msgDatabaseGrowing": {
        def: "**Your database is getting larger!** But do not worry, we can address it now. The time before running out of space on the remote storage.\n\n| Measured size | Configured size |\n| --- | --- |\n| ${estimatedSize} | ${maxSize} |\n\n> [!MORE]-\n> If you have been using it for many years, there may be unreferenced chunks - that is, garbage - accumulating in the database. Therefore, we recommend rebuilding everything. It will probably become much smaller.\n> \n> If the volume of your vault is simply increasing, it is better to rebuild everything after organizing the files. Self-hosted LiveSync does not delete the actual data even if you delete it to speed up the process. It is roughly [documented](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/tech_info.md).\n> \n> If you don't mind the increase, you can increase the notification limit by 100MB. This is the case if you are running it on your own server. However, it is better to rebuild everything from time to time.\n> \n\n> [!WARNING]\n> If you perform rebuild everything, make sure all devices are synchronised. The plug-in will merge as much as possible, though.\n",
        es: "**¡Tu base de datos está creciendo!** Pero no te preocupes, podemos abordarlo ahora. El tiempo antes de quedarse sin espacio en el almacenamiento remoto.\n\n| Tamaño medido | Tamaño configurado |\n| --- | --- |\n| ${estimatedSize} | ${maxSize} |\n\n> [!MORE]-\n> Si lo has estado utilizando durante muchos años, puede haber fragmentos no referenciados - es decir, basura - acumulándose en la base de datos. Por lo tanto, recomendamos reconstruir todo. Probablemente se volverá mucho más pequeño.\n>\n> Si el volumen de tu bóveda simplemente está aumentando, es mejor reconstruir todo después de organizar los archivos. Self-hosted LiveSync no elimina los datos reales incluso si los eliminas para acelerar el proceso. Está aproximadamente [documentado](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/tech_info.md).\n>\n> Si no te importa el aumento, puedes aumentar el límite de notificación en 100 MB. Este es el caso si lo estás ejecutando en tu propio servidor. Sin embargo, es mejor reconstruir todo de vez en cuando.\n>\n\n> [!WARNING]\n> Si realizas la reconstrucción completa, asegúrate de que todos los dispositivos estén sincronizados. El complemento fusionará tanto como sea posible, sin embargo.\n",
    },
    "moduleCheckRemoteSize.optionIncreaseLimit": {
        def: "increase to ${newMax}MB",
        es: "aumentar a ${newMax}MB",
    },
    "moduleCheckRemoteSize.optionRebuildAll": {
        def: "Rebuild Everything Now",
        es: "Reconstruir todo ahora",
    },
    "moduleCheckRemoteSize.optionDismiss": {
        def: "Dismiss",
        es: "Descartar",
    },
    "moduleCheckRemoteSize.msgConfirmRebuild": {
        def: "This may take a bit of a long time. Do you really want to rebuild everything now?",
        es: "Esto puede llevar un poco de tiempo. ¿Realmente quieres reconstruir todo ahora?",
    },
    "moduleCheckRemoteSize.logThresholdEnlarged": {
        def: "Threshold has been enlarged to ${size}MB",
        es: "El umbral se ha ampliado a ${size}MB",
    },
    "moduleCheckRemoteSize.logExceededWarning": {
        def: "Remote storage size: ${measuredSize} exceeded ${notifySize}",
        es: "Tamaño del almacenamiento remoto: ${measuredSize} superó ${notifySize}",
    },
    "moduleCheckRemoteSize.logCurrentStorageSize": {
        def: "Remote storage size: ${measuredSize}",
        es: "Tamaño del almacenamiento remoto: ${measuredSize}",
    },
    "moduleInputUIObsidian.defaultTitleConfirmation": {
        def: "Confirmation",
        es: "Confirmación",
    },
    "moduleInputUIObsidian.optionYes": {
        def: "Yes",
        es: "Sí",
    },
    "moduleInputUIObsidian.optionNo": {
        def: "No",
        es: "No",
    },
    "moduleInputUIObsidian.defaultTitleSelect": {
        def: "Select",
        es: "Seleccionar",
    },
    "moduleLiveSyncMain.optionKeepLiveSyncDisabled": {
        def: "Keep LiveSync disabled",
        es: "Mantener LiveSync desactivado",
    },
    "moduleLiveSyncMain.optionResumeAndRestart": {
        def: "Resume and restart Obsidian",
        es: "Reanudar y reiniciar Obsidian",
    },
    "moduleLiveSyncMain.msgScramEnabled": {
        def: "Self-hosted LiveSync has been configured to ignore some events. Is this correct?\n\n| Type | Status | Note |\n|:---:|:---:|---|\n| Storage Events | ${fileWatchingStatus} | Every modification will be ignored |\n| Database Events | ${parseReplicationStatus} | Every synchronised change will be postponed |\n\nDo you want to resume them and restart Obsidian?\n\n> [!DETAILS]-\n> These flags are set by the plug-in while rebuilding, or fetching. If the process ends abnormally, it may be kept unintended.\n> If you are not sure, you can try to rerun these processes. Make sure to back your vault up.\n",
        es: "Self-hosted LiveSync se ha configurado para ignorar algunos eventos. ¿Es esto correcto?\n\n| Tipo | Estado | Nota |\n|:---:|:---:|---|\n| Eventos de almacenamiento | ${fileWatchingStatus} | Se ignorará cada modificación |\n| Eventos de base de datos | ${parseReplicationStatus} | Cada cambio sincronizado se pospondrá |\n\n¿Quieres reanudarlos y reiniciar Obsidian?\n\n> [!DETAILS]-\n> Estas banderas son establecidas por el complemento mientras se reconstruye o se obtiene. Si el proceso termina de forma anormal, puede mantenerse sin querer.\n> Si no estás seguro, puedes intentar volver a ejecutar estos procesos. Asegúrate de hacer una copia de seguridad de tu bóveda.\n",
    },
    "moduleLiveSyncMain.titleScramEnabled": {
        def: "Scram Enabled",
        es: "Scram habilitado",
    },
    "moduleLiveSyncMain.logAdditionalSafetyScan": {
        def: "Additional safety scan...",
        es: "Escanéo de seguridad adicional...",
    },
    "moduleLiveSyncMain.logSafetyScanFailed": {
        def: "Additional safety scan has failed on a module",
        es: "El escaneo de seguridad adicional ha fallado en un módulo",
    },
    "moduleLiveSyncMain.logSafetyScanCompleted": {
        def: "Additional safety scan completed",
        es: "Escanéo de seguridad adicional completado",
    },
    "moduleLiveSyncMain.logLoadingPlugin": {
        def: "Loading plugin...",
        es: "Cargando complemento...",
    },
    "moduleLiveSyncMain.logPluginInitCancelled": {
        def: "Plugin initialisation was cancelled by a module",
        es: "La inicialización del complemento fue cancelada por un módulo",
    },
    "moduleLiveSyncMain.logPluginVersion": {
        def: "Self-hosted LiveSync v${manifestVersion} ${packageVersion}",
        es: "Self-hosted LiveSync v${manifestVersion} ${packageVersion}",
    },
    "moduleLiveSyncMain.logReadChangelog": {
        def: "LiveSync has updated, please read the changelog!",
        es: "LiveSync se ha actualizado, ¡por favor lee el registro de cambios!",
    },
    "moduleLiveSyncMain.logVersionUpdate": {
        def: "LiveSync has been updated, In case of breaking updates, all automatic synchronization has been temporarily disabled. Ensure that all devices are up to date before enabling.",
        es: "LiveSync se ha actualizado, en caso de actualizaciones que rompan, toda la sincronización automática se ha desactivado temporalmente. Asegúrate de que todos los dispositivos estén actualizados antes de habilitar.",
    },
    "moduleLiveSyncMain.logUnloadingPlugin": {
        def: "Unloading plugin...",
        es: "Descargando complemento...",
    },
    "obsidianLiveSyncSettingTab.levelPowerUser": {
        def: " (Power User)",
        es: " (experto)",
    },
    "obsidianLiveSyncSettingTab.levelAdvanced": {
        def: " (Advanced)",
        es: " (avanzado)",
    },
    "obsidianLiveSyncSettingTab.levelEdgeCase": {
        def: " (Edge Case)",
        es: " (excepción)",
    },
    "obsidianLiveSyncSettingTab.logEstimatedSize": {
        def: "Estimated size: ${size}",
        es: "Tamaño estimado: ${size}",
    },
    "obsidianLiveSyncSettingTab.msgSettingModified": {
        def: 'The setting "${setting}" was modified from another device. Click {HERE} to reload settings. Click elsewhere to ignore changes.',
        es: 'La configuración "${setting}" fue modificada desde otro dispositivo. Haz clic {HERE} para recargar la configuración. Haz clic en otro lugar para ignorar los cambios.',
    },
    "obsidianLiveSyncSettingTab.optionHere": {
        def: "HERE",
        es: "AQUÍ",
    },
    "obsidianLiveSyncSettingTab.logPassphraseInvalid": {
        def: "Passphrase is not valid, please fix it.",
        es: "La frase de contraseña no es válida, por favor corrígela.",
    },
    "obsidianLiveSyncSettingTab.optionFetchFromRemote": {
        def: "Fetch from Remote",
        es: "Obtener del remoto",
    },
    "obsidianLiveSyncSettingTab.optionRebuildBoth": {
        def: "Rebuild Both from This Device",
        es: "Reconstructuir ambos desde este dispositivo",
    },
    "obsidianLiveSyncSettingTab.optionSaveOnlySettings": {
        def: "(Danger) Save Only Settings",
        es: "(Peligro) Guardar solo configuración",
    },
    "obsidianLiveSyncSettingTab.optionCancel": {
        def: "Cancel",
        es: "Cancelar",
    },
    "obsidianLiveSyncSettingTab.titleRebuildRequired": {
        def: "Rebuild Required",
        es: "Reconstrucción necesaria",
    },
    "obsidianLiveSyncSettingTab.msgRebuildRequired": {
        def: "Rebuilding Databases are required to apply the changes.. Please select the method to apply the changes.\n\n<details>\n<summary>Legends</summary>\n\n| Symbol | Meaning |\n|: ------ :| ------- |\n| ⇔ | Up to Date |\n| ⇄ | Synchronise to balance |\n| ⇐,⇒ | Transfer to overwrite |\n| ⇠,⇢ | Transfer to overwrite from other side |\n\n</details>\n\n## ${OPTION_REBUILD_BOTH}\nAt a glance:  📄 ⇒¹ 💻 ⇒² 🛰️ ⇢ⁿ 💻 ⇄ⁿ⁺¹ 📄\nReconstruct both the local and remote databases using existing files from this device.\nThis causes a lockout other devices, and they need to perform fetching.\n## ${OPTION_FETCH}\nAt a glance: 📄 ⇄² 💻 ⇐¹ 🛰️ ⇔ 💻 ⇔ 📄\nInitialise the local database and reconstruct it using data fetched from the remote database.\nThis case includes the case which you have rebuilt the remote database.\n## ${OPTION_ONLY_SETTING}\nStore only the settings. **Caution: This may lead to data corruption**; database reconstruction is generally necessary.",
        es: "Es necesario reconstruir las bases de datos para aplicar los cambios. Por favor selecciona el método para aplicar los cambios.\n\n<details>\n<summary>Legendas</summary>\n\n| Símbolo | Significado |\n|: ------ :| ------- |\n| ⇔ | Actualizado |\n| ⇄ | Sincronizar para equilibrar |\n| ⇐,⇒ | Transferir para sobrescribir |\n| ⇠,⇢ | Transferir para sobrescribir desde otro lado |\n\n</details>\n\n## ${OPTION_REBUILD_BOTH}\nA simple vista:  📄 ⇒¹ 💻 ⇒² 🛰️ ⇢ⁿ 💻 ⇄ⁿ⁺¹ 📄\nReconstruir tanto la base de datos local como la remota utilizando los archivos existentes de este dispositivo.\nEsto bloquea a otros dispositivos, y necesitan realizar la obtención.\n## ${OPTION_FETCH}\nA simple vista: 📄 ⇄² 💻 ⇐¹ 🛰️ ⇔ 💻 ⇔ 📄\nInicializa la base de datos local y la reconstruye utilizando los datos obtenidos de la base de datos remota.\nEste caso incluye el caso en el que has reconstruido la base de datos remota.\n## ${OPTION_ONLY_SETTING}\nAlmacena solo la configuración. **Precaución: esto puede provocar corrupción de datos**; generalmente es necesario reconstruir la base de datos.",
    },
    "obsidianLiveSyncSettingTab.msgAreYouSureProceed": {
        def: "Are you sure to proceed?",
        es: "¿Estás seguro de proceder?",
    },
    "obsidianLiveSyncSettingTab.msgChangesNeedToBeApplied": {
        def: "Changes need to be applied!",
        es: "¡Los cambios deben aplicarse!",
    },
    "obsidianLiveSyncSettingTab.optionApply": {
        def: "Apply",
        es: "Aplicar",
    },
    "obsidianLiveSyncSettingTab.logCheckPassphraseFailed": {
        def: "ERROR: Failed to check passphrase with the remote server: \n${db}.",
        es: "ERROR: Error al comprobar la frase de contraseña con el servidor remoto: \n${db}.",
    },
    "obsidianLiveSyncSettingTab.logDatabaseConnected": {
        def: "Database connected",
        es: "Base de datos conectada",
    },
    "obsidianLiveSyncSettingTab.logPassphraseNotCompatible": {
        def: "ERROR: Passphrase is not compatible with the remote server! Please check it again!",
        es: "ERROR: ¡La frase de contraseña no es compatible con el servidor remoto! ¡Por favor, revísala de nuevo!",
    },
    "obsidianLiveSyncSettingTab.logEncryptionNoPassphrase": {
        def: "You cannot enable encryption without a passphrase",
        es: "No puedes habilitar el cifrado sin una frase de contraseña",
    },
    "obsidianLiveSyncSettingTab.logEncryptionNoSupport": {
        def: "Your device does not support encryption.",
        es: "Tu dispositivo no admite el cifrado.",
    },
    "obsidianLiveSyncSettingTab.logRebuildNote": {
        def: "Syncing has been disabled, fetch and re-enabled if desired.",
        es: "La sincronización ha sido desactivada, obtén y vuelve a activar si lo deseas.",
    },
    "obsidianLiveSyncSettingTab.panelChangeLog": {
        def: "Change Log",
        es: "Registro de cambios",
    },
    "obsidianLiveSyncSettingTab.msgNewVersionNote": {
        def: "Here due to an upgrade notification? Please review the version history. If you're satisfied, click the button. A new update will prompt this again.",
        es: "¿Aquí debido a una notificación de actualización? Por favor, revise el historial de versiones. Si está satisfecho, haga clic en el botón. Una nueva actualización volverá a mostrar esto.",
    },
    "obsidianLiveSyncSettingTab.optionOkReadEverything": {
        def: "OK, I have read everything.",
        es: "OK, he leído todo.",
    },
    "obsidianLiveSyncSettingTab.panelSetup": {
        def: "Setup",
        es: "Configuración",
    },
    "obsidianLiveSyncSettingTab.titleQuickSetup": {
        def: "Quick Setup",
        es: "Configuración rápida",
    },
    "obsidianLiveSyncSettingTab.nameConnectSetupURI": {
        def: "Connect with Setup URI",
        es: "Conectar con URI de configuración",
    },
    "obsidianLiveSyncSettingTab.descConnectSetupURI": {
        def: "This is the recommended method to set up Self-hosted LiveSync with a Setup URI.",
        es: "Este es el método recomendado para configurar Self-hosted LiveSync con una URI de configuración.",
    },
    "obsidianLiveSyncSettingTab.btnUse": {
        def: "Use",
        es: "Usar",
    },
    "obsidianLiveSyncSettingTab.nameManualSetup": {
        def: "Manual Setup",
        es: "Configuración manual",
    },
    "obsidianLiveSyncSettingTab.descManualSetup": {
        def: "Not recommended, but useful if you don't have a Setup URI",
        es: "No recomendado, pero útil si no tienes una URI de configuración",
    },
    "obsidianLiveSyncSettingTab.btnStart": {
        def: "Start",
        es: "Iniciar",
    },
    "obsidianLiveSyncSettingTab.nameEnableLiveSync": {
        def: "Enable LiveSync",
        es: "Activar LiveSync",
    },
    "obsidianLiveSyncSettingTab.descEnableLiveSync": {
        def: "Only enable this after configuring either of the above two options or completing all configuration manually.",
        es: "Solo habilita esto después de configurar cualquiera de las dos opciones anteriores o completar toda la configuración manualmente.",
    },
    "obsidianLiveSyncSettingTab.btnEnable": {
        def: "Enable",
        es: "Activar",
    },
    "obsidianLiveSyncSettingTab.titleSetupOtherDevices": {
        def: "To setup other devices",
        es: "Para configurar otros dispositivos",
    },
    "obsidianLiveSyncSettingTab.nameCopySetupURI": {
        def: "Copy the current settings to a Setup URI",
        es: "Copiar la configuración actual a una URI de configuración",
    },
    "obsidianLiveSyncSettingTab.descCopySetupURI": {
        def: "Perfect for setting up a new device!",
        es: "¡Perfecto para configurar un nuevo dispositivo!",
    },
    "obsidianLiveSyncSettingTab.btnCopy": {
        def: "Copy",
        es: "Copiar",
    },
    "obsidianLiveSyncSettingTab.titleReset": {
        def: "Reset",
        es: "Reiniciar",
    },
    "obsidianLiveSyncSettingTab.nameDiscardSettings": {
        def: "Discard existing settings and databases",
        es: "Descartar configuraciones y bases de datos existentes",
    },
    "obsidianLiveSyncSettingTab.btnDiscard": {
        def: "Discard",
        es: "Descartar",
    },
    "obsidianLiveSyncSettingTab.msgDiscardConfirmation": {
        def: "Do you really want to discard existing settings and databases?",
        es: "¿Realmente deseas descartar las configuraciones y bases de datos existentes?",
    },
    "obsidianLiveSyncSettingTab.titleExtraFeatures": {
        def: "Enable extra and advanced features",
        es: "Habilitar funciones extras y avanzadas",
    },
    "obsidianLiveSyncSettingTab.titleOnlineTips": {
        def: "Online Tips",
        es: "Consejos en línea",
    },
    "obsidianLiveSyncSettingTab.linkTroubleshooting": {
        def: "/docs/troubleshooting.md",
        es: "/docs/es/troubleshooting.md",
    },
    "obsidianLiveSyncSettingTab.linkOpenInBrowser": {
        def: "Open in browser",
        es: "Abrir en el navegador",
    },
    "obsidianLiveSyncSettingTab.logErrorOccurred": {
        def: "An error occurred!!",
        es: "¡Ocurrió un error!",
    },
    "obsidianLiveSyncSettingTab.linkTipsAndTroubleshooting": {
        def: "Tips and Troubleshooting",
        es: "Consejos y solución de problemas",
    },
    "obsidianLiveSyncSettingTab.linkPageTop": {
        def: "Page Top",
        es: "Ir arriba",
    },
    "obsidianLiveSyncSettingTab.panelGeneralSettings": {
        def: "General Settings",
        es: "Configuraciones Generales",
    },
    "obsidianLiveSyncSettingTab.titleAppearance": {
        def: "Appearance",
        es: "Apariencia",
    },
    "obsidianLiveSyncSettingTab.defaultLanguage": {
        def: "Default",
        es: "Predeterminado",
    },
    "obsidianLiveSyncSettingTab.titleLogging": {
        def: "Logging",
        es: "Registro",
    },
    "obsidianLiveSyncSettingTab.btnNext": {
        def: "Next",
        es: "Siguiente",
    },
    "obsidianLiveSyncSettingTab.logCheckingDbConfig": {
        def: "Checking database configuration",
        es: "Verificando la configuración de la base de datos",
    },
    "obsidianLiveSyncSettingTab.logCannotUseCloudant": {
        def: "This feature cannot be used with IBM Cloudant.",
        es: "Esta función no se puede utilizar con IBM Cloudant.",
    },
    "obsidianLiveSyncSettingTab.btnFix": {
        def: "Fix",
        es: "Corregir",
    },
    "obsidianLiveSyncSettingTab.logCouchDbConfigSet": {
        def: "CouchDB Configuration: ${title} -> Set ${key} to ${value}",
        es: "Configuración de CouchDB: ${title} -> Establecer ${key} en ${value}",
    },
    "obsidianLiveSyncSettingTab.logCouchDbConfigUpdated": {
        def: "CouchDB Configuration: ${title} successfully updated",
        es: "Configuración de CouchDB: ${title} actualizado correctamente",
    },
    "obsidianLiveSyncSettingTab.logCouchDbConfigFail": {
        def: "CouchDB Configuration: ${title} failed",
        es: "Configuración de CouchDB: ${title} falló",
    },
    "obsidianLiveSyncSettingTab.msgNotice": {
        def: "---Notice---",
        es: "---Aviso---",
    },
    "obsidianLiveSyncSettingTab.msgIfConfigNotPersistent": {
        def: "If the server configuration is not persistent (e.g., running on docker), the values here may change. Once you are able to connect, please update the settings in the server's local.ini.",
        es: "Si la configuración del servidor no es persistente (por ejemplo, ejecutándose en docker), los valores aquí pueden cambiar. Una vez que puedas conectarte, por favor actualiza las configuraciones en el local.ini del servidor.",
    },
    "obsidianLiveSyncSettingTab.msgConfigCheck": {
        def: "--Config check--",
        es: "--Verificación de configuración--",
    },
    "obsidianLiveSyncSettingTab.warnNoAdmin": {
        def: "⚠ You do not have administrator privileges.",
        es: "⚠ No tienes privilegios de administrador.",
    },
    "obsidianLiveSyncSettingTab.okAdminPrivileges": {
        def: "✔ You have administrator privileges.",
        es: "✔ Tienes privilegios de administrador.",
    },
    "obsidianLiveSyncSettingTab.errRequireValidUser": {
        def: "❗ chttpd.require_valid_user is wrong.",
        es: "❗ chttpd.require_valid_user es incorrecto.",
    },
    "obsidianLiveSyncSettingTab.msgSetRequireValidUser": {
        def: "Set chttpd.require_valid_user = true",
        es: "Configurar chttpd.require_valid_user = true",
    },
    "obsidianLiveSyncSettingTab.okRequireValidUser": {
        def: "✔ chttpd.require_valid_user is ok.",
        es: "✔ chttpd.require_valid_user está correcto.",
    },
    "obsidianLiveSyncSettingTab.errRequireValidUserAuth": {
        def: "❗ chttpd_auth.require_valid_user is wrong.",
        es: "❗ chttpd_auth.require_valid_user es incorrecto.",
    },
    "obsidianLiveSyncSettingTab.msgSetRequireValidUserAuth": {
        def: "Set chttpd_auth.require_valid_user = true",
        es: "Configurar chttpd_auth.require_valid_user = true",
    },
    "obsidianLiveSyncSettingTab.okRequireValidUserAuth": {
        def: "✔ chttpd_auth.require_valid_user is ok.",
        es: "✔ chttpd_auth.require_valid_user está correcto.",
    },
    "obsidianLiveSyncSettingTab.errMissingWwwAuth": {
        def: "❗ httpd.WWW-Authenticate is missing",
        es: "❗ httpd.WWW-Authenticate falta",
    },
    "obsidianLiveSyncSettingTab.msgSetWwwAuth": {
        def: "Set httpd.WWW-Authenticate",
        es: "Configurar httpd.WWW-Authenticate",
    },
    "obsidianLiveSyncSettingTab.okWwwAuth": {
        def: "✔ httpd.WWW-Authenticate is ok.",
        es: "✔ httpd.WWW-Authenticate está correcto.",
    },
    "obsidianLiveSyncSettingTab.errEnableCors": {
        def: "❗ httpd.enable_cors is wrong",
        es: "❗ httpd.enable_cors es incorrecto",
    },
    "obsidianLiveSyncSettingTab.msgEnableCors": {
        def: "Set httpd.enable_cors",
        es: "Configurar httpd.enable_cors",
    },
    "obsidianLiveSyncSettingTab.okEnableCors": {
        def: "✔ httpd.enable_cors is ok.",
        es: "✔ httpd.enable_cors está correcto.",
    },
    "obsidianLiveSyncSettingTab.errMaxRequestSize": {
        def: "❗ chttpd.max_http_request_size is low)",
        es: "❗ chttpd.max_http_request_size es bajo)",
    },
    "obsidianLiveSyncSettingTab.msgSetMaxRequestSize": {
        def: "Set chttpd.max_http_request_size",
        es: "Configurar chttpd.max_http_request_size",
    },
    "obsidianLiveSyncSettingTab.okMaxRequestSize": {
        def: "✔ chttpd.max_http_request_size is ok.",
        es: "✔ chttpd.max_http_request_size está correcto.",
    },
    "obsidianLiveSyncSettingTab.errMaxDocumentSize": {
        def: "❗ couchdb.max_document_size is low)",
        es: "❗ couchdb.max_document_size es bajo)",
    },
    "obsidianLiveSyncSettingTab.msgSetMaxDocSize": {
        def: "Set couchdb.max_document_size",
        es: "Configurar couchdb.max_document_size",
    },
    "obsidianLiveSyncSettingTab.okMaxDocumentSize": {
        def: "✔ couchdb.max_document_size is ok.",
        es: "✔ couchdb.max_document_size está correcto.",
    },
    "obsidianLiveSyncSettingTab.errCorsCredentials": {
        def: "❗ cors.credentials is wrong",
        es: "❗ cors.credentials es incorrecto",
    },
    "obsidianLiveSyncSettingTab.msgSetCorsCredentials": {
        def: "Set cors.credentials",
        es: "Configurar cors.credentials",
    },
    "obsidianLiveSyncSettingTab.okCorsCredentials": {
        def: "✔ cors.credentials is ok.",
        es: "✔ cors.credentials está correcto.",
    },
    "obsidianLiveSyncSettingTab.okCorsOrigins": {
        def: "✔ cors.origins is ok.",
        es: "✔ cors.origins está correcto.",
    },
    "obsidianLiveSyncSettingTab.errCorsOrigins": {
        def: "❗ cors.origins is wrong",
        es: "❗ cors.origins es incorrecto",
    },
    "obsidianLiveSyncSettingTab.msgSetCorsOrigins": {
        def: "Set cors.origins",
        es: "Configurar cors.origins",
    },
    "obsidianLiveSyncSettingTab.msgConnectionCheck": {
        def: "--Connection check--",
        es: "--Verificación de conexión--",
    },
    "obsidianLiveSyncSettingTab.msgCurrentOrigin": {
        def: "Current origin: {origin}",
        es: "Origen actual: {origin}",
    },
    "obsidianLiveSyncSettingTab.msgOriginCheck": {
        def: "Origin check: {org}",
        es: "Verificación de origen: {org}",
    },
    "obsidianLiveSyncSettingTab.errCorsNotAllowingCredentials": {
        def: "❗ CORS is not allowing credentials",
        es: "CORS no permite credenciales",
    },
    "obsidianLiveSyncSettingTab.okCorsCredentialsForOrigin": {
        def: "CORS credentials OK",
        es: "CORS credenciales OK",
    },
    "obsidianLiveSyncSettingTab.warnCorsOriginUnmatched": {
        def: "⚠ CORS Origin is unmatched {from}->{to}",
        es: "⚠ El origen de CORS no coincide: {from}->{to}",
    },
    "obsidianLiveSyncSettingTab.okCorsOriginMatched": {
        def: "✔ CORS origin OK",
        es: "✔ Origen de CORS correcto",
    },
    "obsidianLiveSyncSettingTab.msgDone": {
        def: "--Done--",
        es: "--Hecho--",
    },
    "obsidianLiveSyncSettingTab.msgConnectionProxyNote": {
        def: "If you're having trouble with the Connection-check (even after checking config), please check your reverse proxy configuration.",
        es: "Si tienes problemas con la verificación de conexión (incluso después de verificar la configuración), por favor verifica la configuración de tu proxy reverso.",
    },
    "obsidianLiveSyncSettingTab.logCheckingConfigDone": {
        def: "Checking configuration done",
        es: "Verificación de configuración completada",
    },
    "obsidianLiveSyncSettingTab.errAccessForbidden": {
        def: "❗ Access forbidden.",
        es: "Acceso prohibido.",
    },
    "obsidianLiveSyncSettingTab.errCannotContinueTest": {
        def: "We could not continue the test.",
        es: "No se pudo continuar con la prueba.",
    },
    "obsidianLiveSyncSettingTab.logCheckingConfigFailed": {
        def: "Checking configuration failed",
        es: "La verificación de configuración falló",
    },
    "obsidianLiveSyncSettingTab.panelRemoteConfiguration": {
        def: "Remote Configuration",
        es: "Configuración remota",
    },
    "obsidianLiveSyncSettingTab.titleRemoteServer": {
        def: "Remote Server",
        es: "Servidor remoto",
    },
    "obsidianLiveSyncSettingTab.optionCouchDB": {
        def: "CouchDB",
        es: "CouchDB",
    },
    "obsidianLiveSyncSettingTab.optionMinioS3R2": {
        def: "Minio,S3,R2",
        es: "Minio,S3,R2",
    },
    "obsidianLiveSyncSettingTab.titleMinioS3R2": {
        def: "Minio,S3,R2",
        es: "Minio,S3,R2",
    },
    "obsidianLiveSyncSettingTab.msgObjectStorageWarning": {
        def: "WARNING: This feature is a Work In Progress, so please keep in mind the following:\n- Append only architecture. A rebuild is required to shrink the storage.\n- A bit fragile.\n- When first syncing, all history will be transferred from the remote. Be mindful of data caps and slow speeds.\n- Only differences are synced live.\n\nIf you run into any issues, or have ideas about this feature, please create a issue on GitHub.\nI appreciate you for your great dedication.",
        es: "ADVERTENCIA: Esta característica está en desarrollo, así que por favor ten en cuenta lo siguiente:\n- Arquitectura de solo anexado. Se requiere una reconstrucción para reducir el almacenamiento.\n- Un poco frágil.\n- Al sincronizar por primera vez, todo el historial será transferido desde el remoto. Ten en cuenta los límites de datos y las velocidades lentas.\n- Solo las diferencias se sincronizan en vivo.\n\nSi encuentras algún problema o tienes ideas sobre esta característica, por favor crea un issue en GitHub.\nAprecio mucho tu gran dedicación.",
    },
    "obsidianLiveSyncSettingTab.nameTestConnection": {
        def: "Test Connection",
        es: "Probar conexión",
    },
    "obsidianLiveSyncSettingTab.btnTest": {
        def: "Test",
        es: "Probar",
    },
    "obsidianLiveSyncSettingTab.nameApplySettings": {
        def: "Apply Settings",
        es: "Aplicar configuraciones",
    },
    "obsidianLiveSyncSettingTab.titleCouchDB": {
        def: "CouchDB",
        es: "CouchDB",
    },
    "obsidianLiveSyncSettingTab.msgNonHTTPSWarning": {
        def: "Cannot connect to non-HTTPS URI. Please update your config and try again.",
        es: "No se puede conectar a URI que no sean HTTPS. Por favor, actualiza tu configuración y vuelve a intentarlo.",
    },
    "obsidianLiveSyncSettingTab.msgNonHTTPSInfo": {
        def: "Configured as non-HTTPS URI. Be warned that this may not work on mobile devices.",
        es: "Configurado como URI que no es HTTPS. Ten en cuenta que esto puede no funcionar en dispositivos móviles.",
    },
    "obsidianLiveSyncSettingTab.msgSettingsUnchangeableDuringSync": {
        def: 'These settings are unable to be changed during synchronization. Please disable all syncing in the "Sync Settings" to unlock.',
        es: 'Estas configuraciones no se pueden cambiar durante la sincronización. Por favor, deshabilita toda la sincronización en las "Configuraciones de Sincronización" para desbloquear.',
    },
    "obsidianLiveSyncSettingTab.nameTestDatabaseConnection": {
        def: "Test Database Connection",
        es: "Probar Conexión de Base de Datos",
    },
    "obsidianLiveSyncSettingTab.descTestDatabaseConnection": {
        def: "Open database connection. If the remote database is not found and you have permission to create a database, the database will be created.",
        es: "Abrir conexión a la base de datos. Si no se encuentra la base de datos remota y tienes permiso para crear una base de datos, se creará la base de datos.",
    },
    "obsidianLiveSyncSettingTab.nameValidateDatabaseConfig": {
        def: "Validate Database Configuration",
        es: "Validar Configuración de la Base de Datos",
    },
    "obsidianLiveSyncSettingTab.descValidateDatabaseConfig": {
        def: "Checks and fixes any potential issues with the database config.",
        es: "Verifica y soluciona cualquier problema potencial con la configuración de la base de datos.",
    },
    "obsidianLiveSyncSettingTab.btnCheck": {
        def: "Check",
        es: "Verificar",
    },
    "obsidianLiveSyncSettingTab.titleNotification": {
        def: "Notification",
        es: "Notificación",
    },
    "obsidianLiveSyncSettingTab.panelPrivacyEncryption": {
        def: "Privacy & Encryption",
        es: "Privacidad y Cifrado",
    },
    "obsidianLiveSyncSettingTab.titleFetchSettings": {
        def: "Fetch Settings",
        es: "Obtener configuraciones",
    },
    "obsidianLiveSyncSettingTab.titleFetchConfigFromRemote": {
        def: "Fetch config from remote server",
        es: "Obtener configuración del servidor remoto",
    },
    "obsidianLiveSyncSettingTab.descFetchConfigFromRemote": {
        def: "Fetch necessary settings from already configured remote server.",
        es: "Obtener las configuraciones necesarias del servidor remoto ya configurado.",
    },
    "obsidianLiveSyncSettingTab.buttonFetch": {
        def: "Fetch",
        es: "Obtener",
    },
    "obsidianLiveSyncSettingTab.buttonNext": {
        def: "Next",
        es: "Siguiente",
    },
    "obsidianLiveSyncSettingTab.msgConfigCheckFailed": {
        def: "The configuration check has failed. Do you want to continue anyway?",
        es: "La verificación de configuración ha fallado. ¿Quieres continuar de todos modos?",
    },
    "obsidianLiveSyncSettingTab.titleRemoteConfigCheckFailed": {
        def: "Remote Configuration Check Failed",
        es: "La verificación de configuración remota falló",
    },
    "obsidianLiveSyncSettingTab.msgEnableEncryptionRecommendation": {
        def: "We recommend enabling End-To-End Encryption, and Path Obfuscation. Are you sure you want to continue without encryption?",
        es: "Recomendamos habilitar el cifrado de extremo a extremo y la obfuscación de ruta. ¿Estás seguro de querer continuar sin cifrado?",
    },
    "obsidianLiveSyncSettingTab.titleEncryptionNotEnabled": {
        def: "Encryption is not enabled",
        es: "El cifrado no está habilitado",
    },
    "obsidianLiveSyncSettingTab.msgInvalidPassphrase": {
        def: "Your encryption passphrase might be invalid. Are you sure you want to continue?",
        es: "Tu frase de contraseña de cifrado podría ser inválida. ¿Estás seguro de querer continuar?",
    },
    "obsidianLiveSyncSettingTab.titleEncryptionPassphraseInvalid": {
        def: "Encryption Passphrase Invalid",
        es: "La frase de contraseña de cifrado es inválida",
    },
    "obsidianLiveSyncSettingTab.msgFetchConfigFromRemote": {
        def: "Do you want to fetch the config from the remote server?",
        es: "¿Quieres obtener la configuración del servidor remoto?",
    },
    "obsidianLiveSyncSettingTab.titleFetchConfig": {
        def: "Fetch Config",
        es: "Obtener configuración",
    },
    "obsidianLiveSyncSettingTab.titleSyncSettings": {
        def: "Sync Settings",
        es: "Configuraciones de Sincronización",
    },
    "obsidianLiveSyncSettingTab.btnGotItAndUpdated": {
        def: "I got it and updated.",
        es: "Lo entendí y actualicé.",
    },
    "obsidianLiveSyncSettingTab.msgSelectAndApplyPreset": {
        def: "Please select and apply any preset item to complete the wizard.",
        es: "Por favor, selecciona y aplica cualquier elemento preestablecido para completar el asistente.",
    },
    "obsidianLiveSyncSettingTab.titleSynchronizationPreset": {
        def: "Synchronization Preset",
        es: "Preestablecimiento de sincronización",
    },
    "obsidianLiveSyncSettingTab.optionLiveSync": {
        def: "LiveSync",
        es: "LiveSync",
    },
    "obsidianLiveSyncSettingTab.optionPeriodicWithBatch": {
        def: "Periodic w/ batch",
        es: "Periódico con lote",
    },
    "obsidianLiveSyncSettingTab.optionDisableAllAutomatic": {
        def: "Disable all automatic",
        es: "Desactivar lo automático",
    },
    "obsidianLiveSyncSettingTab.btnApply": {
        def: "Apply",
        es: "Aplicar",
    },
    "obsidianLiveSyncSettingTab.logSelectAnyPreset": {
        def: "Select any preset.",
        es: "Selecciona cualquier preestablecido.",
    },
    "obsidianLiveSyncSettingTab.logConfiguredLiveSync": {
        def: "Configured synchronization mode: LiveSync",
        es: "Modo de sincronización configurado: Sincronización en Vivo",
    },
    "obsidianLiveSyncSettingTab.logConfiguredPeriodic": {
        def: "Configured synchronization mode: Periodic",
        es: "Modo de sincronización configurado: Periódico",
    },
    "obsidianLiveSyncSettingTab.logConfiguredDisabled": {
        def: "Configured synchronization mode: DISABLED",
        es: "Modo de sincronización configurado: DESACTIVADO",
    },
    "obsidianLiveSyncSettingTab.msgGenerateSetupURI": {
        def: "All done! Do you want to generate a setup URI to set up other devices?",
        es: "¡Todo listo! ¿Quieres generar un URI de configuración para configurar otros dispositivos?",
    },
    "obsidianLiveSyncSettingTab.titleCongratulations": {
        def: "Congratulations!",
        es: "¡Felicidades!",
    },
    "obsidianLiveSyncSettingTab.titleSynchronizationMethod": {
        def: "Synchronization Method",
        es: "Método de sincronización",
    },
    "obsidianLiveSyncSettingTab.optionOnEvents": {
        def: "On events",
        es: "En eventos",
    },
    "obsidianLiveSyncSettingTab.optionPeriodicAndEvents": {
        def: "Periodic and on events",
        es: "Periódico y en eventos",
    },
    "obsidianLiveSyncSettingTab.titleUpdateThinning": {
        def: "Update Thinning",
        es: "Actualización de adelgazamiento",
    },
    "obsidianLiveSyncSettingTab.titleDeletionPropagation": {
        def: "Deletion Propagation",
        es: "Propagación de eliminación",
    },
    "obsidianLiveSyncSettingTab.titleConflictResolution": {
        def: "Conflict resolution",
        es: "Resolución de conflictos",
    },
    "obsidianLiveSyncSettingTab.titleSyncSettingsViaMarkdown": {
        def: "Sync Settings via Markdown",
        es: "Configuración de sincronización a través de Markdown",
    },
    "obsidianLiveSyncSettingTab.titleHiddenFiles": {
        def: "Hidden Files",
        es: "Archivos ocultos",
    },
    "obsidianLiveSyncSettingTab.labelEnabled": {
        def: "🔁 : Enabled",
        es: "🔁 : Activado",
    },
    "obsidianLiveSyncSettingTab.labelDisabled": {
        def: "⏹️ : Disabled",
        es: "⏹️ : Desactivado",
    },
    "obsidianLiveSyncSettingTab.nameHiddenFileSynchronization": {
        def: "Hidden file synchronization",
        es: "Sincronización de archivos ocultos",
    },
    "obsidianLiveSyncSettingTab.nameDisableHiddenFileSync": {
        def: "Disable Hidden files sync",
        es: "Desactivar sincronización de archivos ocultos",
    },
    "obsidianLiveSyncSettingTab.btnDisable": {
        def: "Disable",
        es: "Desactivar",
    },
    "obsidianLiveSyncSettingTab.nameEnableHiddenFileSync": {
        def: "Enable Hidden files sync",
        es: "Activar sincronización de archivos ocultos",
    },
    "Enable advanced features": {
        def: "Enable advanced features",
        es: "Habilitar características avanzadas",
    },
    "Enable poweruser features": {
        def: "Enable poweruser features",
        es: "Habilitar funciones para usuarios avanzados",
    },
    "Enable edge case treatment features": {
        def: "Enable edge case treatment features",
        es: "Habilitar manejo de casos límite",
    },
    lang_def: {
        def: "Default",
    },
    "lang-def": {
        def: "%{lang_def}",
    },
    "lang-de": {
        def: "Deutsche",
        es: "Alemán",
    },
    "lang-es": {
        def: "Español",
        es: "Español",
    },
    "lang-ja": {
        def: "日本語",
        es: "Japonés",
    },
    "lang-ru": {
        def: "Русский",
        es: "Ruso",
    },
    "lang-zh": {
        def: "简体中文",
        es: "Chino simplificado",
    },
    "lang-zh-tw": {
        def: "繁體中文",
        es: "Chino tradicional",
    },
    "Display Language": {
        def: "Display Language",
        es: "Idioma de visualización",
        ja: "インターフェースの表示言語",
        zh: "显示语言",
    },
    'Not all messages have been translated. And, please revert to "Default" when reporting errors.': {
        def: 'Not all messages have been translated. And, please revert to "Default" when reporting errors.',
        es: 'No todos los mensajes están traducidos. Por favor, vuelva a "Predeterminado" al reportar errores.',
        ja: 'すべてのメッセージが翻訳されているわけではありません。また、Issue報告の際にはいったん"Default"に戻してください',
        zh: '并非所有消息都已翻译。请在报告错误时恢复为"Default"',
    },
    "Show status inside the editor": {
        def: "Show status inside the editor",
        es: "Mostrar estado dentro del editor",
        ja: "ステータスをエディタ内に表示",
        zh: "在编辑器内显示状态",
    },
    "Requires restart of Obsidian.": {
        def: "Requires restart of Obsidian.",
        es: "Requiere reiniciar Obsidian",
    },
    "Show status as icons only": {
        def: "Show status as icons only",
        es: "Mostrar estado solo con íconos",
        ja: "ステータス表示をアイコンのみにする",
        zh: "仅以图标显示状态",
    },
    "Show status on the status bar": {
        def: "Show status on the status bar",
        es: "Mostrar estado en la barra de estado",
        ja: "ステータスバーに、ステータスを表示",
        zh: "在状态栏上显示状态",
    },
    "Show only notifications": {
        def: "Show only notifications",
        es: "Mostrar solo notificaciones",
        ja: "通知のみ表示",
        zh: "仅显示通知",
    },
    "Disables logging, only shows notifications. Please disable if you report an issue.": {
        def: "Disables logging, only shows notifications. Please disable if you report an issue.",
        es: "Desactiva registros, solo muestra notificaciones. Desactívelo si reporta un problema.",
    },
    "Verbose Log": {
        def: "Verbose Log",
        es: "Registro detallado",
        ja: "エラー以外のログ項目",
        zh: "详细日志",
    },
    "Show verbose log. Please enable if you report an issue.": {
        def: "Show verbose log. Please enable if you report an issue.",
        es: "Mostrar registro detallado. Actívelo si reporta un problema.",
        ja: "エラー以外の詳細ログ項目も表示する。問題が発生した場合は有効にしてください。",
    },
    "Remote Type": {
        def: "Remote Type",
        es: "Tipo de remoto",
        ja: "同期方式",
        zh: "远程类型",
    },
    "Remote server type": {
        def: "Remote server type",
        es: "Tipo de servidor remoto",
        ja: "リモートの種別",
        zh: "远程服务器类型",
    },
    "Notify when the estimated remote storage size exceeds on start up": {
        def: "Notify when the estimated remote storage size exceeds on start up",
        es: "Notificar cuando el tamaño estimado del almacenamiento remoto exceda al iniciar",
    },
    "MB (0 to disable).": {
        def: "MB (0 to disable).",
        es: "MB (0 para desactivar)",
    },
    "End-to-End Encryption": {
        def: "End-to-End Encryption",
        es: "Cifrado de extremo a extremo",
        ja: "E2E暗号化",
        zh: "端到端加密",
    },
    "Encrypt contents on the remote database. If you use the plugin's synchronization feature, enabling this is recommended.":
        {
            def: "Encrypt contents on the remote database. If you use the plugin's synchronization feature, enabling this is recommended.",
            es: "Cifrar contenido en la base de datos remota. Se recomienda habilitar si usa la sincronización del plugin.",
            ja: "リモートデータベースの暗号化（オンにすることをお勧めします）",
            zh: "加密远程数据库中的内容。如果您使用插件的同步功能，则建议启用此功能。",
        },
    Passphrase: {
        def: "Passphrase",
        es: "Frase de contraseña",
        ja: "パスフレーズ",
        zh: "口令",
    },
    "Encryption phassphrase. If changed, you should overwrite the server's database with the new (encrypted) files.": {
        def: "Encryption phassphrase. If changed, you should overwrite the server's database with the new (encrypted) files.",
        es: "Frase de cifrado. Si la cambia, sobrescriba la base del servidor con los nuevos archivos cifrados.",
    },
    "Path Obfuscation": {
        def: "Path Obfuscation",
        es: "Ofuscación de rutas",
        ja: "パスの難読化",
        zh: "路径混淆",
    },
    "Use dynamic iteration count": {
        def: "Use dynamic iteration count",
        es: "Usar conteo de iteraciones dinámico",
        ja: "動的な繰り返し回数",
        zh: "使用动态迭代次数",
    },
    Presets: {
        def: "Presets",
        es: "Preconfiguraciones",
        ja: "プリセット",
        zh: "预设",
    },
    "Apply preset configuration": {
        def: "Apply preset configuration",
        es: "Aplicar configuración predefinida",
        ja: "初期設定値に戻す",
        zh: "应用预设配置",
    },
    "Sync Mode": {
        def: "Sync Mode",
        es: "Modo de sincronización",
        ja: "同期モード",
        zh: "同步模式",
    },
    "Periodic Sync interval": {
        def: "Periodic Sync interval",
        es: "Intervalo de sincronización periódica",
        ja: "定時同期の感覚",
        zh: "定期同步间隔",
    },
    "Interval (sec)": {
        def: "Interval (sec)",
        es: "Intervalo (segundos)",
        ja: "秒",
        zh: "间隔（秒）",
    },
    "Sync on Save": {
        def: "Sync on Save",
        es: "Sincronizar al guardar",
        ja: "保存時に同期",
        zh: "保存时同步",
    },
    "Starts synchronisation when a file is saved.": {
        def: "Starts synchronisation when a file is saved.",
        es: "Inicia sincronización al guardar un archivo",
    },
    "Sync on Editor Save": {
        def: "Sync on Editor Save",
        es: "Sincronizar al guardar en editor",
        ja: "エディタでの保存時に、同期されます",
        zh: "编辑器保存时同步",
    },
    "When you save a file in the editor, start a sync automatically": {
        def: "When you save a file in the editor, start a sync automatically",
        es: "Iniciar sincronización automática al guardar en editor",
        ja: "エディタでファイルを保存すると、自動的に同期を開始します",
    },
    "Sync on File Open": {
        def: "Sync on File Open",
        es: "Sincronizar al abrir archivo",
        ja: "ファイルを開いた時に同期",
        zh: "打开文件时同步",
    },
    "Forces the file to be synced when opened.": {
        def: "Forces the file to be synced when opened.",
        es: "Forzar sincronización al abrir archivo",
    },
    "Sync on Startup": {
        def: "Sync on Startup",
        es: "Sincronizar al iniciar",
        ja: "起動時同期",
        zh: "启动时同步",
    },
    "Automatically Sync all files when opening Obsidian.": {
        def: "Automatically Sync all files when opening Obsidian.",
        es: "Sincronizar automáticamente todos los archivos al abrir Obsidian",
    },
    "Sync after merging file": {
        def: "Sync after merging file",
        es: "Sincronizar tras fusionar archivo",
        ja: "ファイルがマージ(統合)された時に同期",
        zh: "合并文件后同步",
    },
    "Sync automatically after merging files": {
        def: "Sync automatically after merging files",
        es: "Sincronizar automáticamente tras fusionar archivos",
    },
    "Batch database update": {
        def: "Batch database update",
        es: "Actualización por lotes de BD",
        ja: "データベースのバッチ更新",
        zh: "批量数据库更新",
    },
    "Reducing the frequency with which on-disk changes are reflected into the DB": {
        def: "Reducing the frequency with which on-disk changes are reflected into the DB",
        es: "Reducir frecuencia de actualizaciones de disco a BD",
        zh: "降低将磁盘上的更改反映到数据库中的频率",
    },
    "Minimum delay for batch database updating": {
        def: "Minimum delay for batch database updating",
        es: "Retraso mínimo para actualización por lotes",
        zh: "批量数据库更新的最小延迟",
    },
    "Seconds. Saving to the local database will be delayed until this value after we stop typing or saving.": {
        def: "Seconds. Saving to the local database will be delayed until this value after we stop typing or saving.",
        es: "Segundos. Guardado en BD local se retrasará hasta este valor tras dejar de escribir/guardar",
        zh: "秒。在停止输入或保存后，保存到本地数据库将延迟此值。",
    },
    "Maximum delay for batch database updating": {
        def: "Maximum delay for batch database updating",
        es: "Retraso máximo para actualización por lotes",
        zh: "批量数据库更新的最大延迟",
    },
    "Saving will be performed forcefully after this number of seconds.": {
        def: "Saving will be performed forcefully after this number of seconds.",
        es: "Guardado forzado tras esta cantidad de segundos",
        zh: "在此秒数后将强制执行保存。",
    },
    "Use the trash bin": {
        def: "Use the trash bin",
        es: "Usar papelera",
        ja: "ゴミ箱を使用",
        zh: "使用回收站",
    },
    "Move remotely deleted files to the trash, instead of deleting.": {
        def: "Move remotely deleted files to the trash, instead of deleting.",
        es: "Mover archivos borrados remotos a papelera en lugar de eliminarlos",
    },
    "Keep empty folder": {
        def: "Keep empty folder",
        es: "Mantener carpetas vacías",
        ja: "空フォルダの維持",
        zh: "保留空文件夹",
    },
    "Should we keep folders that don't have any files inside?": {
        def: "Should we keep folders that don't have any files inside?",
        es: "¿Mantener carpetas vacías?",
    },
    "(BETA) Always overwrite with a newer file": {
        def: "(BETA) Always overwrite with a newer file",
        es: "(BETA) Sobrescribir siempre con archivo más nuevo",
        ja: "(ベータ機能) 常に新しいファイルで上書きする",
        zh: "始终使用更新的文件覆盖（测试版）",
    },
    "Testing only - Resolve file conflicts by syncing newer copies of the file, this can overwrite modified files. Be Warned.":
        {
            def: "Testing only - Resolve file conflicts by syncing newer copies of the file, this can overwrite modified files. Be Warned.",
            es: "Solo pruebas - Resolver conflictos sincronizando copias nuevas (puede sobrescribir modificaciones)",
        },
    "Delay conflict resolution of inactive files": {
        def: "Delay conflict resolution of inactive files",
        es: "Retrasar resolución de conflictos en archivos inactivos",
        ja: "無効なファイルは、競合解決を先送りする",
        zh: "推迟解决不活动文件",
    },
    "Should we only check for conflicts when a file is opened?": {
        def: "Should we only check for conflicts when a file is opened?",
        es: "¿Solo comprobar conflictos al abrir archivo?",
    },
    "Delay merge conflict prompt for inactive files.": {
        def: "Delay merge conflict prompt for inactive files.",
        es: "Retrasar aviso de fusión para archivos inactivos",
        ja: "手動で無効なファイルの競合を解決する",
        zh: "推迟手动解决不活动文件",
    },
    "Should we prompt you about conflicting files when a file is opened?": {
        def: "Should we prompt you about conflicting files when a file is opened?",
        es: "¿Notificar sobre conflictos al abrir archivo?",
        zh: "当文件打开时，是否提示冲突文件？",
    },
    Filename: {
        def: "Filename",
        es: "Nombre de archivo",
        ja: "ファイル名",
        zh: "文件名",
    },
    "Save settings to a markdown file. You will be notified when new settings arrive. You can set different files by the platform.":
        {
            def: "Save settings to a markdown file. You will be notified when new settings arrive. You can set different files by the platform.",
            es: "Guardar configuración en archivo markdown. Se notificarán nuevos ajustes. Puede definir diferentes archivos por plataforma",
            zh: "如果设置了此项，所有设置都将保存在一个Markdown文件中。当新设置到达时，您将收到通知。您可以根据平台设置不同的文件。",
        },
    "Write credentials in the file": {
        def: "Write credentials in the file",
        es: "Escribir credenciales en archivo",
        ja: "クレデンシャルのファイル内保存",
        zh: "将凭据写入文件",
    },
    "(Not recommended) If set, credentials will be stored in the file.": {
        def: "(Not recommended) If set, credentials will be stored in the file.",
        es: "(No recomendado) Almacena credenciales en el archivo",
        zh: "（不建议）如果设置，凭据将存储在文件中。",
    },
    "Notify all setting files": {
        def: "Notify all setting files",
        es: "Notificar todos los archivos de configuración",
        ja: "すべての設定を通知",
        zh: "通知所有设置文件",
    },
    "Suppress notification of hidden files change": {
        def: "Suppress notification of hidden files change",
        es: "Suprimir notificaciones de cambios en archivos ocultos",
    },
    "If enabled, the notification of hidden files change will be suppressed.": {
        def: "If enabled, the notification of hidden files change will be suppressed.",
        es: "Si se habilita, se suprimirá la notificación de cambios en archivos ocultos.",
    },
    "Scan for hidden files before replication": {
        def: "Scan for hidden files before replication",
        es: "Escanear archivos ocultos antes de replicar",
        ja: "レプリケーション開始前に、隠しファイルのスキャンを行う",
        zh: "复制前扫描隐藏文件",
    },
    "Scan hidden files periodically": {
        def: "Scan hidden files periodically",
        es: "Escanear archivos ocultos periódicamente",
        ja: "定期的に隠しファイルのスキャンを行う",
        zh: "定期扫描隐藏文件",
    },
    "Seconds, 0 to disable": {
        def: "Seconds, 0 to disable",
        es: "Segundos, 0 para desactivar",
        zh: "秒，0为禁用",
    },
    "Maximum file size": {
        def: "Maximum file size",
        es: "Tamaño máximo de archivo",
        ja: "最大ファイル容量",
        zh: "最大文件大小",
    },
    "(MB) If this is set, changes to local and remote files that are larger than this will be skipped. If the file becomes smaller again, a newer one will be used.":
        {
            def: "(MB) If this is set, changes to local and remote files that are larger than this will be skipped. If the file becomes smaller again, a newer one will be used.",
            es: "(MB) Saltar cambios en archivos locales/remotos mayores a este tamaño. Si se reduce, se usará versión nueva",
            zh: "（MB）如果设置了此项，大于此大小的本地和远程文件的更改将被跳过。如果文件再次变小，将使用更新的文件",
        },
    "(Beta) Use ignore files": {
        def: "(Beta) Use ignore files",
        es: "(Beta) Usar archivos de ignorar",
        ja: "(ベータ機能) 無視ファイル(ignore)の使用",
        zh: "（测试版）使用忽略文件",
    },
    "If this is set, changes to local files which are matched by the ignore files will be skipped. Remote changes are determined using local ignore files.":
        {
            def: "If this is set, changes to local files which are matched by the ignore files will be skipped. Remote changes are determined using local ignore files.",
            es: "Saltar cambios en archivos locales que coincidan con ignore files. Cambios remotos usan ignore files locales",
            zh: "如果设置了此项，与忽略文件匹配的本地文件的更改将被跳过。远程更改使用本地忽略文件确定",
        },
    "Ignore files": {
        def: "Ignore files",
        es: "Archivos a ignorar",
        ja: "無視ファイル",
        zh: "忽略文件",
    },
    "Comma separated `.gitignore, .dockerignore`": {
        def: "Comma separated `.gitignore, .dockerignore`",
        es: "Separados por comas: `.gitignore, .dockerignore`",
        zh: "我们可以使用多个忽略文件，例如`.gitignore, .dockerignore`",
    },
    "Device name": {
        def: "Device name",
        es: "Nombre del dispositivo",
        ja: "デバイスネーム",
        zh: "设备名称",
    },
    "Unique name between all synchronized devices. To edit this setting, please disable customization sync once.": {
        def: "Unique name between all synchronized devices. To edit this setting, please disable customization sync once.",
        es: "Nombre único entre dispositivos sincronizados. Para editarlo, desactive sincronización de personalización",
        ja: "一意の名称を、すべての端末に設定します。この設定を変更した場合、カスタマイズ同期機能を無効にしてください。",
        zh: "所有同步设备之间的唯一名称。要编辑此设置，请首先禁用自定义同步",
    },
    "Per-file-saved customization sync": {
        def: "Per-file-saved customization sync",
        es: "Sincronización de personalización por archivo",
        zh: "按文件保存的自定义同步",
    },
    "If enabled per-filed efficient customization sync will be used. We need a small migration when enabling this. And all devices should be updated to v0.23.18. Once we enabled this, we lost a compatibility with old versions.":
        {
            def: "If enabled per-filed efficient customization sync will be used. We need a small migration when enabling this. And all devices should be updated to v0.23.18. Once we enabled this, we lost a compatibility with old versions.",
            es: "Habilita sincronización eficiente por archivo. Requiere migración y actualizar todos dispositivos a v0.23.18. Pierde compatibilidad con versiones antiguas",
        },
    "Enable customization sync": {
        def: "Enable customization sync",
        es: "Habilitar sincronización de personalización",
        ja: "カスタマイズ同期を有効",
        zh: "启用自定义同步",
    },
    "K.ScanCustomization": {
        def: "Scan customization",
    },
    "Scan customization automatically": {
        def: "Scan customization automatically",
        es: "Escanear personalización automáticamente",
        ja: "自動的にカスタマイズをスキャン",
        zh: "自动扫描自定义设置",
    },
    "Scan customization before replicating.": {
        def: "Scan customization before replicating.",
        es: "Escanear personalización antes de replicar",
        ja: "レプリケーション前に、カスタマイズをスキャン",
        zh: "在复制前扫描自定义设置",
    },
    "Scan customization periodically": {
        def: "Scan customization periodically",
        es: "Escanear personalización periódicamente",
        ja: "定期的にカスタマイズをスキャン",
        zh: "定期扫描自定义设置",
    },
    "Scan customization every 1 minute.": {
        def: "Scan customization every 1 minute.",
        es: "Escanear personalización cada 1 minuto",
        ja: "カスタマイズのスキャンを1分ごとに行う",
        zh: "每1分钟扫描自定义设置",
    },
    "Notify customized": {
        def: "Notify customized",
        es: "Notificar personalizaciones",
        ja: "カスタマイズが行われたら通知する",
        zh: "通知自定义设置",
    },
    "Notify when other device has newly customized.": {
        def: "Notify when other device has newly customized.",
        es: "Notificar cuando otro dispositivo personalice",
        ja: "別の端末がカスタマイズを行なったら通知する",
        zh: "当其他设备有新的自定义设置时通知",
    },
    "Write logs into the file": {
        def: "Write logs into the file",
        es: "Escribir logs en archivo",
        ja: "ファイルにログを記録",
        zh: "将日志写入文件",
    },
    "Warning! This will have a serious impact on performance. And the logs will not be synchronised under the default name. Please be careful with logs; they often contain your confidential information.":
        {
            def: "Warning! This will have a serious impact on performance. And the logs will not be synchronised under the default name. Please be careful with logs; they often contain your confidential information.",
            es: "¡Advertencia! Impacta rendimiento. Los logs no se sincronizan con nombre predeterminado. Contienen información confidencial",
            zh: "警告！这将严重影响性能。并且日志不会以默认名称同步。请小心处理日志；它们通常包含您的敏感信息",
        },
    "Suspend file watching": {
        def: "Suspend file watching",
        es: "Suspender monitorización de archivos",
        ja: "監視の一時停止",
        zh: "暂停文件监视",
    },
    "Stop watching for file changes.": {
        def: "Stop watching for file changes.",
        es: "Dejar de monitorear cambios en archivos",
        ja: "監視の停止",
    },
    "Suspend database reflecting": {
        def: "Suspend database reflecting",
        es: "Suspender reflejo de base de datos",
        ja: "データベース反映の一時停止",
        zh: "暂停数据库反映",
    },
    "Stop reflecting database changes to storage files.": {
        def: "Stop reflecting database changes to storage files.",
        es: "Dejar de reflejar cambios de BD en archivos",
        ja: "データベースの変更をストレージファイルに反映させない",
    },
    "Memory cache size (by total items)": {
        def: "Memory cache size (by total items)",
        es: "Tamaño caché memoria (por ítems)",
        ja: "全体のキャッシュサイズ",
        zh: "内存缓存大小（按总项目数）",
    },
    "Memory cache size (by total characters)": {
        def: "Memory cache size (by total characters)",
        es: "Tamaño caché memoria (por caracteres)",
        ja: "全体でキャッシュする文字数",
        zh: "内存缓存大小（按总字符数）",
    },
    "(Mega chars)": {
        def: "(Mega chars)",
        es: "(Millones de caracteres)",
        zh: "（百万字符）",
    },
    "Enhance chunk size": {
        def: "Enhance chunk size",
        es: "Mejorar tamaño de chunks",
        ja: "チャンクサイズを最新にする",
        zh: "增强块大小",
    },
    "Use splitting-limit-capped chunk splitter": {
        def: "Use splitting-limit-capped chunk splitter",
        es: "Usar divisor de chunks con límite",
    },
    "If enabled, chunks will be split into no more than 100 items. However, dedupe is slightly weaker.": {
        def: "If enabled, chunks will be split into no more than 100 items. However, dedupe is slightly weaker.",
        es: "Divide chunks en máximo 100 ítems. Menos eficiente en deduplicación",
    },
    "Use Segmented-splitter": {
        def: "Use Segmented-splitter",
        es: "Usar divisor segmentado",
    },
    "If this enabled, chunks will be split into semantically meaningful segments. Not all platforms support this feature.":
        {
            def: "If this enabled, chunks will be split into semantically meaningful segments. Not all platforms support this feature.",
            es: "Divide chunks en segmentos semánticos. No todos los sistemas lo soportan",
        },
    "Fetch chunks on demand": {
        def: "Fetch chunks on demand",
        es: "Obtener chunks bajo demanda",
        ja: "ユーザーのタイミングでチャンクの更新を確認する",
        zh: "按需获取块",
    },
    "(ex. Read chunks online) If this option is enabled, LiveSync reads chunks online directly instead of replicating them locally. Increasing Custom chunk size is recommended.":
        {
            def: "(ex. Read chunks online) If this option is enabled, LiveSync reads chunks online directly instead of replicating them locally. Increasing Custom chunk size is recommended.",
            es: "(Ej: Leer chunks online) Lee chunks directamente en línea. Aumente tamaño de chunks personalizados",
            zh: "（例如，在线读取块）如果启用此选项，LiveSync将直接在线读取块，而不是在本地复制块。建议增加自定义块大小",
        },
    "Batch size of on-demand fetching": {
        def: "Batch size of on-demand fetching",
        es: "Tamaño de lote para obtención bajo demanda",
        zh: "按需获取的批量大小",
    },
    "The delay for consecutive on-demand fetches": {
        def: "The delay for consecutive on-demand fetches",
        es: "Retraso entre obtenciones consecutivas",
        zh: "连续按需获取的延迟",
    },
    "Incubate Chunks in Document": {
        def: "Incubate Chunks in Document",
        es: "Incubar chunks en documento",
        ja: "ドキュメント内でハッチングを行う",
        zh: "在文档中孵化块",
    },
    "If enabled, newly created chunks are temporarily kept within the document, and graduated to become independent chunks once stabilised.":
        {
            def: "If enabled, newly created chunks are temporarily kept within the document, and graduated to become independent chunks once stabilised.",
            es: "Chunks nuevos se mantienen temporalmente en el documento hasta estabilizarse",
            zh: "如果启用，新创建的数据块将暂时保留在文档中，并在稳定后成为独立数据块。",
        },
    "Maximum Incubating Chunks": {
        def: "Maximum Incubating Chunks",
        es: "Máximo de chunks incubados",
        ja: "最大ハッチング数",
        zh: "最大孵化块数",
    },
    "The maximum number of chunks that can be incubated within the document. Chunks exceeding this number will immediately graduate to independent chunks.":
        {
            def: "The maximum number of chunks that can be incubated within the document. Chunks exceeding this number will immediately graduate to independent chunks.",
            es: "Número máximo de chunks que pueden incubarse en el documento. Excedentes se independizan",
            zh: "文档中可以孵化的数据块的最大数量。超过此数量的数据块将立即成为独立数据块。",
        },
    "Maximum Incubating Chunk Size": {
        def: "Maximum Incubating Chunk Size",
        es: "Tamaño máximo de chunks incubados",
        ja: "保持するチャンクの最大サイズ",
        zh: "最大孵化块大小",
    },
    "The maximum total size of chunks that can be incubated within the document. Chunks exceeding this size will immediately graduate to independent chunks.":
        {
            def: "The maximum total size of chunks that can be incubated within the document. Chunks exceeding this size will immediately graduate to independent chunks.",
            es: "Tamaño total máximo de chunks incubados. Excedentes se independizan",
            zh: "文档中可以孵化的数据块的最大尺寸。超过此大小的数据块将立即成为独立数据块。",
        },
    "Maximum Incubation Period": {
        def: "Maximum Incubation Period",
        es: "Periodo máximo de incubación",
        ja: "最大保持期限",
        zh: "最大孵化期限",
    },
    "The maximum duration for which chunks can be incubated within the document. Chunks exceeding this period will graduate to independent chunks.":
        {
            def: "The maximum duration for which chunks can be incubated within the document. Chunks exceeding this period will graduate to independent chunks.",
            es: "Duración máxima para incubar chunks. Excedentes se independizan",
            zh: "文档中可以孵化的数据块的最大持续时间。超过此时间的数据块将成为独立数据块。",
        },
    "Data Compression": {
        def: "Data Compression",
        es: "Compresión de datos",
        ja: "データ圧縮",
        zh: "数据压缩",
    },
    "Batch size": {
        def: "Batch size",
        es: "Tamaño de lote",
        ja: "バッチ容量",
        zh: "批量大小",
    },
    "Number of changes to sync at a time. Defaults to 50. Minimum is 2.": {
        def: "Number of changes to sync at a time. Defaults to 50. Minimum is 2.",
        es: "Número de cambios a sincronizar simultáneamente. Default 50, mínimo 2",
        zh: "一次处理的更改源项目数。默认为50。最小为2",
    },
    "Batch limit": {
        def: "Batch limit",
        es: "Límite de lotes",
        ja: "バッチの上限",
        zh: "批量限制",
    },
    "Number of batches to process at a time. Defaults to 40. Minimum is 2. This along with batch size controls how many docs are kept in memory at a time.":
        {
            def: "Number of batches to process at a time. Defaults to 40. Minimum is 2. This along with batch size controls how many docs are kept in memory at a time.",
            es: "Número de lotes a procesar. Default 40, mínimo 2. Controla documentos en memoria",
            ja: "1度に処理するバッチの数。デフォルトは40、最小は2。この数値は、どれだけの容量の書類がメモリに保存されるかも定義します。",
            zh: "一次处理的批量数。默认为40。最小为2。这与批量大小一起控制一次在内存中保留多少文档",
        },
    "Use timeouts instead of heartbeats": {
        def: "Use timeouts instead of heartbeats",
        es: "Usar timeouts en lugar de latidos",
        ja: "ハートビートの代わりにタイムアウトを使用",
        zh: "使用超时而不是心跳",
    },
    "If this option is enabled, PouchDB will hold the connection open for 60 seconds, and if no change arrives in that time, close and reopen the socket, instead of holding it open indefinitely. Useful when a proxy limits request duration but can increase resource usage.":
        {
            def: "If this option is enabled, PouchDB will hold the connection open for 60 seconds, and if no change arrives in that time, close and reopen the socket, instead of holding it open indefinitely. Useful when a proxy limits request duration but can increase resource usage.",
            es: "Mantiene conexión 60s. Si no hay cambios, reinicia socket. Útil con proxies limitantes",
            ja: "PouchDBの接続を60秒間維持し、その間に変更がない場合、接続を切断してソケットを再び開きます。プロキシによるリクエスト時間制限があり、なおかつリソースの使用量が増える可能性がある場合に便利です。",
            zh: "如果启用此选项，PouchDB将保持连接打开60秒，如果在此时间内没有更改到达，则关闭并重新打开套接字，而不是无限期保持打开。当代理限制请求持续时间时有用，但可能会增加资源使用",
        },
    "Encrypting sensitive configuration items": {
        def: "Encrypting sensitive configuration items",
        es: "Cifrando elementos sensibles",
        ja: "機微設定項目の暗号化",
        zh: "加密敏感配置项",
    },
    "Passphrase of sensitive configuration items": {
        def: "Passphrase of sensitive configuration items",
        es: "Frase para elementos sensibles",
        ja: "機微設定項目にパスフレーズを使用",
        zh: "敏感配置项的口令",
    },
    "This passphrase will not be copied to another device. It will be set to `Default` until you configure it again.": {
        def: "This passphrase will not be copied to another device. It will be set to `Default` until you configure it again.",
        es: "Esta frase no se copia a otros dispositivos. Usará `Default` hasta reconfigurar",
        zh: "此口令不会复制到另一台设备。在您再次配置之前，它将设置为`Default`。",
    },
    "Enable Developers' Debug Tools.": {
        def: "Enable Developers' Debug Tools.",
        es: "Habilitar herramientas de depuración",
    },
    "Requires restart of Obsidian": {
        def: "Requires restart of Obsidian",
        es: "Requiere reiniciar Obsidian",
    },
    "Do not keep metadata of deleted files.": {
        def: "Do not keep metadata of deleted files.",
        es: "No conservar metadatos de archivos borrados",
        ja: "削除済みファイルのメタデータを保持しない",
        zh: "不保留已删除文件的元数据",
    },
    "Delete old metadata of deleted files on start-up": {
        def: "Delete old metadata of deleted files on start-up",
        es: "Borrar metadatos viejos al iniciar",
        ja: "削除済みデータのメタデータをクリーンナップする",
        zh: "启动时删除已删除文件的旧元数据",
    },
    "(Days passed, 0 to disable automatic-deletion)": {
        def: "(Days passed, 0 to disable automatic-deletion)",
        es: "(Días transcurridos, 0 para desactivar)",
        zh: "（天数，0为禁用自动删除）",
    },
    "Always prompt merge conflicts": {
        def: "Always prompt merge conflicts",
        es: "Siempre preguntar en conflictos",
        ja: "常に競合は手動で解決する",
        zh: "始终手动解决冲突",
    },
    "Should we prompt you for every single merge, even if we can safely merge automatcially?": {
        def: "Should we prompt you for every single merge, even if we can safely merge automatcially?",
        es: "¿Preguntar en cada fusión aunque sea automática?",
        zh: "如果打开此开关，即使可以自动进行合并，也会显示合并对话框。（打开可恢复到以前的行为）",
    },
    "Apply Latest Change if Conflicting": {
        def: "Apply Latest Change if Conflicting",
        es: "Aplicar último cambio en conflictos",
        ja: "書類内に競合が発生しても、常に同期内容を反映する",
        zh: "即使笔记存在冲突，也始终反映同步的更改",
    },
    "Enable this option to automatically apply the most recent change to documents even when it conflicts": {
        def: "Enable this option to automatically apply the most recent change to documents even when it conflicts",
        es: "Aplicar cambios recientes automáticamente aunque generen conflictos",
        zh: "打开可恢复到以前的行为",
    },
    "(Obsolete) Use an old adapter for compatibility": {
        def: "(Obsolete) Use an old adapter for compatibility",
        es: "(Obsoleto) Usar adaptador antiguo",
        ja: "古いアダプターを利用（互換性重視）",
        zh: "为了兼容性使用旧适配器",
    },
    "Before v0.17.16, we used an old adapter for the local database. Now the new adapter is preferred. However, it needs local database rebuilding. Please disable this toggle when you have enough time. If leave it enabled, also while fetching from the remote database, you will be asked to disable this.":
        {
            def: "Before v0.17.16, we used an old adapter for the local database. Now the new adapter is preferred. However, it needs local database rebuilding. Please disable this toggle when you have enough time. If leave it enabled, also while fetching from the remote database, you will be asked to disable this.",
            es: "Antes de v0.17.16 usábamos adaptador antiguo. Nuevo adaptador requiere reconstruir BD local. Desactive cuando pueda",
            ja: "v0.17.6までは、古いアダプターをローカル用のデータベースに使用していました。現在は新しいアダプターを推奨しています。しかし、古いデータベースを再構築するためには必要です。有効のままにしておくと、リモートデータベースからフェッチする場合に、この設定を無効にするか質問があります。",
            zh: "在v0.17.16之前，我们使用了旧适配器作为本地数据库。现在更倾向于使用新适配器。但是，它需要重建本地数据库。请在有足够时间时禁用此切换。如果保留启用状态，且在从远程数据库获取时，将要求您禁用此切换",
        },
    "Compute revisions for chunks": {
        def: "Compute revisions for chunks",
    },
    "If this enabled, all chunks will be stored with the revision made from its content. (Previous behaviour)": {
        def: "If this enabled, all chunks will be stored with the revision made from its content. (Previous behaviour)",
        es: "Si se habilita, todos los chunks se almacenan con la revisión hecha desde su contenido. (comportamiento anterior)",
    },
    "Handle files as Case-Sensitive": {
        def: "Handle files as Case-Sensitive",
        es: "Manejar archivos como sensibles a mayúsculas",
    },
    "If this enabled, All files are handled as case-Sensitive (Previous behaviour).": {
        def: "If this enabled, All files are handled as case-Sensitive (Previous behaviour).",
        es: "Si se habilita, todos los archivos se manejan como sensibles a mayúsculas (comportamiento anterior)",
    },
    "Scan changes on customization sync": {
        def: "Scan changes on customization sync",
        es: "Escanear cambios en sincronización de personalización",
        ja: "カスタマイズされた同期時に、変更をスキャンする",
        zh: "在自定义同步时扫描更改",
    },
    "Do not use internal API": {
        def: "Do not use internal API",
        es: "No usar API interna",
        ja: "内部APIを使用しない",
        zh: "不使用内部API",
    },
    "Database suffix": {
        def: "Database suffix",
        es: "Sufijo de base de datos",
        ja: "データベースの接尾詞(サフィックス)",
        zh: "数据库后缀",
    },
    "LiveSync could not handle multiple vaults which have same name without different prefix, This should be automatically configured.":
        {
            def: "LiveSync could not handle multiple vaults which have same name without different prefix, This should be automatically configured.",
            es: "LiveSync no puede manejar múltiples bóvedas con mismo nombre sin prefijo. Se configura automáticamente",
            ja: "LiveSyncは、接頭詞のない同名の保管庫を扱うことができません。この設定は、自動的に設定されます。",
            zh: "LiveSync无法处理具有相同名称但没有不同前缀的多个仓库。这应该自动配置",
        },
    "The Hash algorithm for chunk IDs": {
        def: "The Hash algorithm for chunk IDs",
        es: "Algoritmo hash para IDs de chunks",
        ja: "チャンクIDのハッシュアルゴリズム",
        zh: "块ID的哈希算法",
    },
    "Fetch database with previous behaviour": {
        def: "Fetch database with previous behaviour",
        es: "Obtener BD con comportamiento anterior",
        ja: "以前の手法でデータベースを取得",
        zh: "用以前的行为获取数据库",
    },
    "Do not split chunks in the background": {
        def: "Do not split chunks in the background",
        es: "No dividir chunks en segundo plano",
    },
    "If disabled(toggled), chunks will be split on the UI thread (Previous behaviour).": {
        def: "If disabled(toggled), chunks will be split on the UI thread (Previous behaviour).",
        es: "Si se desactiva, chunks se dividen en hilo UI (comportamiento anterior)",
    },
    "Process small files in the foreground": {
        def: "Process small files in the foreground",
        es: "Procesar archivos pequeños en primer plano",
        zh: "处理小文件于前台",
    },
    "If enabled, the file under 1kb will be processed in the UI thread.": {
        def: "If enabled, the file under 1kb will be processed in the UI thread.",
        es: "Archivos <1kb se procesan en hilo UI",
    },
    "Do not check configuration mismatch before replication": {
        def: "Do not check configuration mismatch before replication",
        es: "No verificar incompatibilidades antes de replicar",
        zh: "在复制前不检查配置不匹配",
    },
    "Endpoint URL": {
        def: "Endpoint URL",
        es: "URL del endpoint",
        ja: "エンドポイントURL",
        zh: "终端节点网址",
    },
    "Access Key": {
        def: "Access Key",
        es: "Clave de acceso",
        ja: "アクセスキー",
        zh: "访问密钥ID",
    },
    "Secret Key": {
        def: "Secret Key",
        es: "Clave secreta",
        ja: "シークレットキー",
        zh: "访问密钥密码",
    },
    Region: {
        def: "Region",
        es: "Región",
        ja: "リージョン",
        zh: "地域",
    },
    "Bucket Name": {
        def: "Bucket Name",
        es: "Nombre del bucket",
        ja: "バケット名",
        zh: "存储桶名称",
    },
    "Use Custom HTTP Handler": {
        def: "Use Custom HTTP Handler",
        es: "Usar manejador HTTP personalizado",
        ja: "カスタムHTTPハンドラーの利用",
        zh: "使用自定义HTTP处理程序",
    },
    "Enable this if your Object Storage doesn't support CORS": {
        def: "Enable this if your Object Storage doesn't support CORS",
        es: "Habilitar si su almacenamiento no soporta CORS",
        zh: "如果您的对象存储无法配置接受CORS，请启用此功能。",
    },
    "Server URI": {
        def: "Server URI",
        es: "URI del servidor",
        ja: "URI",
        zh: "URI",
    },
    Username: {
        def: "Username",
        es: "Usuario",
        ja: "ユーザー名",
        zh: "用户名",
    },
    username: {
        def: "username",
        es: "nombre de usuario",
        ja: "ユーザー名",
        zh: "用户名",
    },
    Password: {
        def: "Password",
        es: "Contraseña",
        ja: "パスワード",
        zh: "密码",
    },
    password: {
        def: "password",
        es: "contraseña",
        ja: "パスワード",
        zh: "密码",
    },
    "Database Name": {
        def: "Database Name",
        es: "Nombre de la base de datos",
        ja: "データベース名",
        zh: "数据库名称",
    },
    "logPane.title": {
        def: "Self-hosted LiveSync Log",
        es: "Registro de Self-hosted LiveSync",
    },
    "logPane.wrap": {
        def: "Wrap",
        es: "Ajustar",
    },
    "logPane.autoScroll": {
        def: "Auto scroll",
        es: "Autodesplazamiento",
    },
    "logPane.pause": {
        def: "Pause",
        es: "Pausar",
    },
    "logPane.logWindowOpened": {
        def: "Log window opened",
        es: "Ventana de registro abierta",
    },
    "cmdConfigSync.showCustomizationSync": {
        def: "Show Customization sync",
        es: "Mostrar sincronización de personalización",
    },
    "moduleObsidianMenu.replicate": {
        def: "Replicate",
        es: "Replicar",
    },
    "moduleLog.showLog": {
        def: "Show Log",
        es: "Mostrar registro",
    },
    "liveSyncReplicator.replicationInProgress": {
        def: "Replication is already in progress",
        es: "Replicación en curso",
    },
    "liveSyncReplicator.oneShotSyncBegin": {
        def: "OneShot Sync begin... (${syncMode})",
        es: "Inicio de sincronización OneShot... (${syncMode})",
    },
    "liveSyncReplicator.couldNotConnectToServer": {
        def: "Could not connect to server.",
        es: "No se pudo conectar al servidor.",
    },
    "liveSyncReplicator.checkingLastSyncPoint": {
        def: "Looking for the point last synchronized point.",
        es: "Buscando el último punto sincronizado.",
    },
    "liveSyncReplicator.cantReplicateLowerValue": {
        def: "We can't replicate more lower value.",
        es: "No podemos replicar un valor más bajo.",
    },
    "liveSyncReplicator.retryLowerBatchSize": {
        def: "Retry with lower batch size:${batch_size}/${batches_limit}",
        es: "Reintentar con tamaño de lote más bajo:${batch_size}/${batches_limit}",
    },
    "liveSyncReplicator.beforeLiveSync": {
        def: "Before LiveSync, start OneShot once...",
        es: "Antes de LiveSync, inicia OneShot...",
    },
    "liveSyncReplicator.liveSyncBegin": {
        def: "LiveSync begin...",
        es: "Inicio de LiveSync...",
    },
    "liveSyncReplicator.couldNotConnectToRemoteDb": {
        def: "Could not connect to remote database: ${d}",
        es: "No se pudo conectar a base de datos remota: ${d}",
    },
    "liveSyncReplicator.couldNotConnectToURI": {
        def: "Could not connect to ${uri}:${dbRet}",
        es: "No se pudo conectar a ${uri}:${dbRet}",
    },
    "liveSyncReplicator.couldNotConnectTo": {
        def: "Could not connect to ${uri} : ${name} \n(${db})",
        es: "No se pudo conectar a ${uri} : ${name} \n(${db})",
    },
    "liveSyncReplicator.remoteDbCorrupted": {
        def: "Remote database is newer or corrupted, make sure to latest version of self-hosted-livesync installed",
        es: "La base de datos remota es más nueva o está dañada, asegúrese de tener la última versión de self-hosted-livesync instalada",
    },
    "liveSyncReplicator.lockRemoteDb": {
        def: "Lock remote database to prevent data corruption",
        es: "Bloquear base de datos remota para prevenir corrupción de datos",
    },
    "liveSyncReplicator.unlockRemoteDb": {
        def: "Unlock remote database to prevent data corruption",
        es: "Desbloquear base de datos remota para prevenir corrupción de datos",
    },
    "liveSyncReplicator.replicationClosed": {
        def: "Replication closed",
        es: "Replicación cerrada",
    },
    "liveSyncReplicator.remoteDbDestroyed": {
        def: "Remote Database Destroyed",
        es: "Base de datos remota destruida",
    },
    "liveSyncReplicator.remoteDbDestroyError": {
        def: "Something happened on Remote Database Destroy:",
        es: "Algo ocurrió al destruir base de datos remota:",
    },
    "liveSyncReplicator.remoteDbCreatedOrConnected": {
        def: "Remote Database Created or Connected",
        es: "Base de datos remota creada o conectada",
    },
    "liveSyncReplicator.markDeviceResolved": {
        def: "Mark this device as 'resolved'.",
        es: "Marcar este dispositivo como 'resuelto'.",
    },
    "liveSyncReplicator.remoteDbMarkedResolved": {
        def: "Remote database has been marked resolved.",
        es: "Base de datos remota marcada como resuelta.",
    },
    "liveSyncReplicator.couldNotMarkResolveRemoteDb": {
        def: "Could not mark resolve remote database.",
        es: "No se pudo marcar como resuelta la base de datos remota.",
    },
    "liveSyncSetting.errorNoSuchSettingItem": {
        def: "No such setting item: ${key}",
        es: "No existe el ajuste: ${key}",
    },
    "liveSyncSetting.valueShouldBeInRange": {
        def: "The value should ${min} < value < ${max}",
        es: "El valor debe estar entre ${min} y ${max}",
    },
    "liveSyncSettings.btnApply": {
        def: "Apply",
        es: "Aplicar",
    },
    "liveSyncSetting.originalValue": {
        def: "Original: ${value}",
        es: "Original: ${value}",
    },
    "K.Peer": {
        def: "Peer",
    },
    "K.P2P": {
        def: "%{Peer}-to-%{Peer}",
    },
    "P2P.P2PReplication": {
        def: "%{P2P} Replication",
    },
    "K.exp": {
        def: "Experimental",
    },
    "K.short_p2p_sync": {
        def: "P2P Sync (%{exp})",
    },
    "K.title_p2p_sync": {
        def: "Peer-to-Peer Sync",
    },
    "K.long_p2p_sync": {
        def: "%{title_p2p_sync} (%{exp})",
    },
    "P2P.PaneTitle": {
        def: "%{long_p2p_sync}",
    },
    "P2P.NotEnabled": {
        def: "%{title_p2p_sync} is not enabled. We cannot open a new connection.",
    },
    "P2P.NoAutoSyncPeers": {
        def: "No auto-sync peers found. Please set peers on the %{long_p2p_sync} pane.",
    },
    "P2P.FailedToOpen": {
        def: "Failed to open P2P connection to the signaling server.",
    },
    "P2P.SyncCompleted": {
        def: "P2P Sync completed.",
    },
    "P2P.SeemsOffline": {
        def: "Peer ${name} seems offline, skipped.",
    },
    "P2P.SyncStartedWith": {
        def: "P2P Sync with ${name} have been started.",
    },
    "P2P.ReplicatorInstanceMissing": {
        def: "P2P Sync replicator is not found, possibly not have been configured or enabled.",
    },
    "P2P.SyncAlreadyRunning": {
        def: "P2P Sync is already running.",
    },
    "P2P.Note.Summary": {
        def: "What is this  feature? (and some important notes, please read once)",
    },
    "P2P.Note.important_note": {
        def: "The Experimental Implementation of the Peer-to-Peer Replicator.",
    },
    "P2P.Note.important_note_sub": {
        def: "This feature is still in the experimental stage. Please be aware that this feature may not work as expected. Furthermore, it may have some bugs, security issues, and other issues. Please use this feature at your own risk. Please contribute to the development of this feature.",
    },
    "P2P.Note.description": {
        def: " This replicator allows us to synchronise our vault with other devices using a peer-to-peer connection. We can        use this to synchronise our vault with our other devices without using a cloud service.\n\nThis replicator is based on Trystero. It also uses a signaling server to establish a connection between devices. The signaling server is used to exchange connection information between devices. It does (or,should) not know or store any of our data.\n\nThe signaling server can be hosted by anyone. This is just a Nostr relay. For the sake of simplicity and checking the behaviour of the replicator, an instance of the signaling server is hosted by vrtmrz. You can use the experimental server provided by vrtmrz, or you can use any other server.\n\nBy the way, even if the signaling server does not store our data, it can see the connection information of some of our devices. Please be aware of this. Also, be cautious when using the server provided by someone else.",
    },
    "P2P.NoKnownPeers": {
        def: "No peers has been detected, waiting incoming other peers...",
    },
    "P2P.DisabledButNeed": {
        def: "%{title_p2p_sync} is disabled. Do you really want to enable it?",
    },
    "P2P.AskPassphraseForDecrypt": {
        def: "The remote peer shared the configuration. Please input the passphrase to decrypt the configuration.",
    },
    "P2P.AskPassphraseForShare": {
        def: "The remote peer requested this device configuration. Please input the passphrase to share the configuration. You can ignore the request by cancelling this dialogue.",
    },
    "Doctor.Dialogue.Title": {
        def: "Self-hosted LiveSync Config Doctor",
    },
    "Doctor.Dialogue.Main": {
        def: "Hi! Config Doctor has been activated because of ${activateReason}!\nAnd, unfortunately some configurations were detected as potential problems.\nPlease be assured. Let's solve them one by one.\n\nTo let you know ahead of time, we will ask you about the following items.\n\n${issues}\n\nShall we get started?",
    },
    "Doctor.Dialogue.TitleFix": {
        def: "Fix issue ${current}/${total}",
    },
    "Doctor.Dialogue.MainFix": {
        def: "**Configuration name:** `${name}`\n**Current value:** `${current}`, **Ideal value:** `${ideal}`\n**Recommendation Level:** ${level}\n**Why this has been detected?**\n${reason}\n\n\n${note}\n\nFix this to the ideal value?",
    },
    "Doctor.Message.RebuildRequired": {
        def: "Attention! A rebuild is required to apply this!",
    },
    "Doctor.Message.RebuildLocalRequired": {
        def: "Attention! A local database rebuild is required to apply this!",
    },
    "Doctor.Message.SomeSkipped": {
        def: "We left some issues as is. Shall I ask you again on next startup?",
    },
    "Doctor.Dialogue.TitleAlmostDone": {
        def: "Almost done!",
    },
    "Doctor.Level.Necessary": {
        def: "Necessary",
    },
    "Doctor.Level.Recommended": {
        def: "Recommended",
    },
    "Doctor.Level.Optional": {
        def: "Optional",
    },
    "Doctor.Level.Must": {
        def: "Must",
    },
    "Doctor.Button.Fix": {
        def: "Fix it",
    },
    "Doctor.Button.FixButNoRebuild": {
        def: "Fix it but no rebuild",
    },
    "Doctor.Button.Skip": {
        def: "Leave it as is",
    },
    "Doctor.Button.Yes": {
        def: "Yes",
    },
    "Doctor.Button.No": {
        def: "No",
    },
    "Doctor.Button.DismissThisVersion": {
        def: "No, and do not ask again until the next release",
    },
    "Doctor.Message.NoIssues": {
        def: "No issues detected!",
    },
    "Setting.TroubleShooting": {
        def: "TroubleShooting",
    },
    "Setting.TroubleShooting.Doctor": {
        def: "Setting Doctor",
    },
    "Setting.TroubleShooting.Doctor.Desc": {
        def: "Detects non optimal settings. (Same as during migration)",
    },
    "TweakMismatchResolve.Table": {
        def: "| Value name | This device | On Remote |\n|: --- |: ---- :|: ---- :|\n${rows}\n\n",
    },
    "TweakMismatchResolve.Table.Row": {
        def: "| ${name} | ${self} | ${remote} |",
    },
    "TweakMismatchResolve.Message.UseRemote.WarningRebuildRequired": {
        def: "\n>[!WARNING]\n> Some remote configurations are not compatible with the local database of this device. Rebuilding the local database will be required.\n> ***Please ensure that you have time and are connected to a stable network to apply!***",
    },
    "TweakMismatchResolve.Message.UseRemote.WarningRebuildRecommended": {
        def: "\n>[!NOTICE]\n> Some changes are compatible but may consume extra storage and transfer volumes. A rebuild is recommended. However, a rebuild may not be performed at present, but may be implemented in future maintenance.\n> ***Please ensure that you have time and are connected to a stable network to apply!***",
    },
    "TweakMismatchResolve.Message.Main": {
        def: "\nThe settings in the remote database are as follows. These values are configured by other devices, which are synchronised with this device at least once.\n\nIf you want to use these settings, please select %{TweakMismatchResolve.Action.UseConfigured}.\nIf you want to keep the settings of this device, please select %{TweakMismatchResolve.Action.Dismiss}.\n\n${table}\n\n>[!TIP]\n> If you want to synchronise all settings, please use `Sync settings via markdown` after applying minimal configuration with this feature.\n\n${additionalMessage}",
    },
    "TweakMismatchResolve.Action.UseRemote": {
        def: "Apply settings to this device",
    },
    "TweakMismatchResolve.Action.UseRemoteWithRebuild": {
        def: "Apply settings to this device, and fetch again",
    },
    "TweakMismatchResolve.Action.UseRemoteAcceptIncompatible": {
        def: "Apply settings to this device, but and ignore incompatibility",
    },
    "TweakMismatchResolve.Action.UseMine": {
        def: "Update remote database settings",
    },
    "TweakMismatchResolve.Action.UseMineWithRebuild": {
        def: "Update remote database settings and rebuild again",
    },
    "TweakMismatchResolve.Action.UseMineAcceptIncompatible": {
        def: "Update remote database settings but keep as is",
    },
    "TweakMismatchResolve.Action.UseConfigured": {
        def: "Use configured settings",
    },
    "TweakMismatchResolve.Action.Dismiss": {
        def: "Dismiss",
    },
    "TweakMismatchResolve.Message.WarningIncompatibleRebuildRequired": {
        def: "\n>[!WARNING]\n> We have detected that some of the values are different to make incompatible the local database with the remote database.\n> Either local or remote rebuilds are required. Both of them takes a few minutes or more. **Make sure it is safe to perform it now.**",
    },
    "TweakMismatchResolve.Message.WarningIncompatibleRebuildRecommended": {
        def: "\n>[!NOTICE]\n> We have detected that some of the values are different to make incompatible the local database with the remote database.\n> Some changes are compatible but may consume extra storage and transfer volumes. A rebuild is recommended. However, a rebuild may not be performed at present, but may be implemented in future maintenance.\n> If you want to rebuild, it takes a few minutes or more. **Make sure it is safe to perform it now.**",
    },
    "TweakMismatchResolve.Message.MainTweakResolving": {
        def: "Your configuration has not been matched with the one on the remote server.\n\nFollowing configuration should be matched:\n\n${table}\n\nLet us know your decision.\n\n${additionalMessage}",
    },
    "TweakMismatchResolve.Title": {
        def: "Configuration Mismatch Detected",
    },
    "TweakMismatchResolve.Title.TweakResolving": {
        def: "Configuration Mismatch Detected",
    },
    "TweakMismatchResolve.Title.UseRemoteConfig": {
        def: "Use Remote Configuration",
    },
    "Replicator.Dialogue.Locked.Title": {
        def: "Locked",
    },
    "Replicator.Dialogue.Locked.Message": {
        def: "Remote database is locked. This is due to a rebuild on one of the terminals.\nThe device is therefore asked to withhold the connection to avoid database corruption.\n\nThere are three options that we can do:\n\n- %{Replicator.Dialogue.Locked.Action.Fetch}\n  The most preferred and reliable way. This will dispose the local database once, and fetch all from the remote database again, In most case, we can perform this safely. However, it takes some time and should be done in stable network.\n- %{Replicator.Dialogue.Locked.Action.Unlock}\n  This method can only be used if we are already reliably synchronised by other replication methods. This does not simply mean that we have the same files. If you are not sure, you should avoid it.\n- %{Replicator.Dialogue.Locked.Action.Dismiss}\n    This will cancel the operation. And we will asked again on next request.\n",
    },
    "Replicator.Dialogue.Locked.Action.Fetch": {
        def: "Fetch all from the remote database again",
    },
    "Replicator.Dialogue.Locked.Action.Unlock": {
        def: "Unlock the remote database",
    },
    "Replicator.Dialogue.Locked.Action.Dismiss": {
        def: "Cancel for reconfirmation",
    },
    "Replicator.Dialogue.Locked.Message.Fetch": {
        def: "Fetch all has been scheduled. Plug-in will be restarted to perform it.",
    },
    "Replicator.Dialogue.Locked.Message.Unlocked": {
        def: "The remote database has been unlocked. Please retry the operation.",
    },
    "Replicator.Message.Cleaned": {
        def: "Database cleaning up is in process. replication has been cancelled",
    },
    "Replicator.Message.VersionUpFlash": {
        def: "Open settings and check message, please. replication has been cancelled.",
    },
    "Replicator.Message.Pending": {
        def: "Some file events are pending. Replication has been cancelled.",
    },
    "Replicator.Message.SomeModuleFailed": {
        def: "Replication has been cancelled by some module failure",
    },
    "Replicator.Message.InitialiseFatalError": {
        def: "No replicator is available, this is the fatal error.",
    },
    "SettingTab.Message.AskRebuild": {
        def: "Your changes require fetching from the remote database. Do you want to proceed?",
    },
    "Setup.ShowQRCode": {
        def: "Show QR code",
    },
    "Setup.ShowQRCode.Desc": {
        def: "Show QR code to transfer the settings.",
    },
    "Setup.QRCode": {
        def: 'We have generated a QR code to transfer the settings. Please scan the QR code with your phone or other device.\nNote: The QR code is not encrypted, so be careful to open this.\n\n>[!FOR YOUR EYES ONLY]-\n> <div class="sls-qr">${qr_image}</div>',
    },
    "RedFlag.Fetch.Method.FetchSafer": {
        def: "Create a local database once before fetching",
    },
    "RedFlag.Fetch.Method.FetchSmoother": {
        def: "Create local file chunks before fetching",
    },
    "RedFlag.Fetch.Method.FetchTraditional": {
        def: "Fetch everything from the remote",
    },
    "RedFlag.Fetch.Method.Title": {
        def: "How do you want to fetch?",
    },
    "RedFlag.Fetch.Method.Desc": {
        def: "How do you want to fetch?\n- %{RedFlag.Fetch.Method.FetchSafer}. (Recommended)\n  **Low Traffic**, **High CPU**, **Low Risk**\n- %{RedFlag.Fetch.Method.FetchSmoother}.\n  **Low Traffic**, **Moderate CPU**, **Low to Moderate Risk**\n- %{RedFlag.Fetch.Method.FetchTraditional}.\n  **High Traffic**, **Low CPU**, **Low to Moderate Risk**\n\n>[!INFO]- Details\n> ## %{RedFlag.Fetch.Method.FetchSafer}. (Recommended)\n> **Low Traffic**, **High CPU**, **Low Risk**\n> This option first creates a local database using existing local files before fetching data from the remote source.\n> If matching files exist both locally and remotely, only the differences between them will be transferred.\n> However, files present in both locations will initially be handled as conflicted files. They will be resolved automatically if they are not actually conflicted, but this process may take time.\n> This is generally the safest method, minimizing data loss risk.\n> ## %{RedFlag.Fetch.Method.FetchSmoother}.\n> **Low Traffic**, **Moderate CPU**, **Low to Moderate Risk** (depending operation)\n> This option first creates chunks from local files for the database, then fetches data. Consequently, only chunks missing locally are transferred. However, all metadata is taken from the remote source.\n> Local files are then compared against this metadata at launch. The content considered newer will overwrite the older one (by modified time). This outcome is then synchronised back to the remote database.\n> This is generally safe if local files are genuinely the latest timestamp. However, it can cause problems if a file has a newer timestamp but older content (like the initial `welcome.md`).\n> This uses less CPU and faster than \"%{RedFlag.Fetch.Method.FetchSafer}\", but it may lead to data loss if not used carefully.\n> ## %{RedFlag.Fetch.Method.FetchTraditional}.\n> **High Traffic**, **Low CPU**, **Low to Moderate Risk** (depending operation)\n> All things will be fetched from the remote.\n> Similar to the %{RedFlag.Fetch.Method.FetchSmoother}, but all chunks are fetched from the remote source.\n> This is the most traditional way to fetch, typically consuming the most network traffic and time. It also carries a similar risk of overwriting remote files to the '%{RedFlag.Fetch.Method.FetchSmoother}' option.\n> However, it is often considered the most stable method because it is the longest-established and most straightforward approach.",
    },
    "Setting.GenerateKeyPair.Title": {
        def: "New key pair has been generated!",
    },
    "Setting.GenerateKeyPair.Desc": {
        def: 'We have generated a key pair!\n\nNote: This key pair will never be shown again. Please save it in a safe place. If you have lost it, you need to generate a new key pair.\nNote 2: The public key is in spki format, and the Private key is in pkcs8 format. For the sake of convenience, newlines are converted to `\\n` in public key.\nNote 3: The public key should be configured in the remote database, and the private key should be configured in local devices.\n\n>[!FOR YOUR EYES ONLY]-\n> <div class="sls-keypair">\n>\n> ### Public Key\n> ```\n${public_key}\n> ```\n>\n> ### Private Key\n> ```\n${private_key}\n> ```\n>\n> </div>\n\n>[!Both for copying]-\n>\n> <div class="sls-keypair">\n>\n> ```\n${public_key}\n${private_key}\n> ```\n>\n> </div>\n\n\n',
    },
    "dialog.yourLanguageAvailable.Title": {
        def: " Translation is available!",
    },
    "dialog.yourLanguageAvailable": {
        def: "Self-hosted LiveSync had translations for your language, so the %{Display language} setting was enabled.\n\nNote: Not all messages are translated. We are waiting for your contributions!\nNote 2: If you create an Issue, **please revert to %{lang-def}** and then take screenshots, messages and logs. This can be done in the setting dialogue.\nMay you find it easy to use!",
        ja: "Self-hosted LiveSync にご利用の言語の翻訳がありましたので、%{Display Language}が適用されました。\n\nご注意： すべてのメッセージは翻訳されていません。あなたのコントリビューションをお待ちしています！\nその２： Issueを作成する際には、 %{Display Language} を一旦 %{lang-def} に戻してから、キャプチャやメッセージ、ログを収集してください。これは設定ダイアログから変更できます。\n\nこれで便利に使用できれば幸いです。",
    },
    "dialog.yourLanguageAvailable.btnRevertToDefault": {
        def: "Keep %{lang-def}",
    },
    "Compute revisions for chunks (Previous behaviour)": {
        es: "Calcular revisiones para chunks (comportamiento anterior)",
    },
} as const;
