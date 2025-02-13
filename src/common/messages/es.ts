export const PartialMessages = {
    es: {
        "moduleMigration.logBulkSendCorrupted":
            "El envío de fragmentos en bloque se ha habilitado, sin embargo, esta función se ha corrompido. Disculpe las molestias. Deshabilitado automáticamente.",
        "moduleMigration.logMigrationFailed": "La migración falló o se canceló de ${old} a ${current}",
        "moduleMigration.logFetchRemoteTweakFailed": "Error al obtener los valores de ajuste remoto",
        "moduleMigration.logRemoteTweakUnavailable": "No se pudieron obtener los valores de ajuste remoto",
        "moduleMigration.logMigratedSameBehaviour": "Migrado a db:${current} con el mismo comportamiento que antes",
        "moduleMigration.logRedflag2CreationFail": "Error al crear redflag2",
        "moduleMigration.logLocalDatabaseNotReady": "¡Algo salió mal! La base de datos local no está lista",
        "moduleMigration.logSetupCancelled":
            "La configuración ha sido cancelada, ¡Self-hosted LiveSync está esperando tu configuración!",
        "moduleMigration.titleCaseSensitivity": "Sensibilidad a mayúsculas",
        "moduleMigration.msgFetchRemoteAgain":
            "Como ya sabrás, Self-hosted LiveSync ha cambiado su comportamiento predeterminado y la estructura de la base de datos.\n\
\n\
Afortunadamente, con tu tiempo y esfuerzo, la base de datos remota parece haber sido ya migrada. ¡Felicidades!\n\
\n\
Sin embargo, necesitamos un poco más. La configuración de este dispositivo no es compatible con la base de datos remota. Necesitaremos volver a obtener la base de datos remota. ¿Debemos obtenerla nuevamente ahora?\n\
\n\
___Nota: No podemos sincronizar hasta que la configuración haya sido cambiada y la base de datos haya sido obtenida nuevamente.___\n\
___Nota2: Los fragmentos son completamente inmutables, solo podemos obtener los metadatos y diferencias.___",
        "moduleMigration.optionYesFetchAgain": "Sí, obtener nuevamente",
        "moduleMigration.optionNoAskAgain": "No, por favor pregúntame de nuevo",
        "moduleMigration.msgSinceV02321":
            "Desde la versión v0.23.21, Self-hosted LiveSync ha cambiado el comportamiento predeterminado y la estructura de la base de datos. Se han realizado los siguientes cambios:\n\
\n\
1. **Sensibilidad a mayúsculas de los nombres de archivo**\n\
    El manejo de los nombres de archivo ahora no distingue entre mayúsculas y minúsculas. Este cambio es beneficioso para la mayoría de las plataformas, excepto Linux y iOS, que no gestionan efectivamente la sensibilidad a mayúsculas de los nombres de archivo.\n\
    (En estos, se mostrará una advertencia para archivos con el mismo nombre pero diferentes mayúsculas).\n\
\n\
2. **Manejo de revisiones de los fragmentos**\n\
    Los fragmentos son inmutables, lo que permite que sus revisiones sean fijas. Este cambio mejorará el rendimiento al guardar archivos.\n\
\n\
___Sin embargo, para habilitar cualquiera de estos cambios, es necesario reconstruir tanto las bases de datos remota como la local. Este proceso toma unos minutos, y recomendamos hacerlo cuando tengas tiempo suficiente.___\n\
\n\
- Si deseas mantener el comportamiento anterior, puedes omitir este proceso usando `${KEEP}`.\n\
- Si no tienes suficiente tiempo, por favor elige `${DISMISS}`. Se te pedirá nuevamente más tarde.\n\
- Si has reconstruido la base de datos en otro dispositivo, selecciona `${DISMISS}` e intenta sincronizar nuevamente. Dado que se ha detectado una diferencia, se te solicitará nuevamente.",
        "moduleMigration.optionEnableBoth": "Habilitar ambos",
        "moduleMigration.optionEnableFilenameCaseInsensitive": "Habilitar solo #1",
        "moduleMigration.optionEnableFixedRevisionForChunks": "Habilitar solo #2",
        "moduleMigration.optionAdjustRemote": "Ajustar al remoto",
        "moduleMigration.optionKeepPreviousBehaviour": "Mantener comportamiento anterior",
        "moduleMigration.optionDecideLater": "Decidirlo más tarde",
        "moduleMigration.titleWelcome": "Bienvenido a Self-hosted LiveSync",
        "moduleMigration.msgInitialSetup":
            "Tu dispositivo **aún no ha sido configurado**. Permíteme guiarte a través del proceso de configuración.\n\
\n\
Ten en cuenta que todo el contenido del diálogo se puede copiar al portapapeles. Si necesitas consultarlo más tarde, puedes pegarlo en una nota en Obsidian. También puedes traducirlo a tu idioma utilizando una herramienta de traducción.\n\
\n\
Primero, ¿tienes **URI de configuración**?\n\
\n\
Nota: Si no sabes qué es, consulta la [documentación](${URI_DOC}).",
        "moduleMigration.docUri": "https://github.com/vrtmrz/obsidian-livesync/blob/main/README_ES.md#how-to-use",
        "moduleMigration.optionHaveSetupUri": "Sí, tengo",
        "moduleMigration.optionNoSetupUri": "No, no tengo",
        "moduleMigration.titleRecommendSetupUri": "Recomendación de uso de URI de configuración",
        "moduleMigration.msgRecommendSetupUri":
            "Te recomendamos encarecidamente que generes una URI de configuración y la utilices.\n\
Si no tienes conocimientos al respecto, consulta la [documentación](${URI_DOC}) (Lo siento de nuevo, pero es importante).\n\
\n\
¿Cómo quieres configurarlo manualmente?",
        "moduleMigration.optionSetupWizard": "Llévame al asistente de configuración",
        "moduleMigration.optionManualSetup": "Configurarlo todo manualmente",
        "moduleMigration.optionRemindNextLaunch": "Recordármelo en el próximo inicio",
        "moduleLocalDatabase.logWaitingForReady": "Esperando a que la base de datos esté lista...",
        "moduleCheckRemoteSize.logCheckingStorageSizes": "Comprobando tamaños de almacenamiento",
        "moduleCheckRemoteSize.titleDatabaseSizeNotify": "Configuración de notificación de tamaño de base de datos",
        "moduleCheckRemoteSize.msgSetDBCapacity":
            "Podemos configurar una advertencia de capacidad máxima de base de datos, **para tomar medidas antes de quedarse sin espacio en el almacenamiento remoto**.\n\
¿Quieres habilitar esto?\n\
\n\
> [!MORE]-\n\
> - 0: No advertir sobre el tamaño del almacenamiento.\n\
>   Esto es recomendado si tienes suficiente espacio en el almacenamiento remoto, especialmente si lo tienes autoalojado. Y puedes comprobar el tamaño del almacenamiento y reconstruir manualmente.\n\
> - 800: Advertir si el tamaño del almacenamiento remoto supera los 800 MB.\n\
>   Esto es recomendado si estás usando fly.io con un límite de 1 GB o IBM Cloudant.\n\
> - 2000: Advertir si el tamaño del almacenamiento remoto supera los 2 GB.\n\
\n\
Si hemos alcanzado el límite, se nos pedirá que aumentemos el límite paso a paso.\n\
",
        "moduleCheckRemoteSize.optionNoWarn": "No, nunca advertir por favor",
        "moduleCheckRemoteSize.option800MB": "800MB (Cloudant, fly.io)",
        "moduleCheckRemoteSize.option2GB": "2GB (Estándar)",
        "moduleCheckRemoteSize.optionAskMeLater": "Pregúntame más tarde",
        "moduleCheckRemoteSize.titleDatabaseSizeLimitExceeded": "El tamaño del almacenamiento remoto superó el límite",
        "moduleCheckRemoteSize.msgDatabaseGrowing":
            "**¡Tu base de datos está creciendo!** Pero no te preocupes, podemos abordarlo ahora. El tiempo antes de quedarse sin espacio en el almacenamiento remoto.\n\
\n\
| Tamaño medido | Tamaño configurado |\n\
| --- | --- |\n\
| ${estimatedSize} | ${maxSize} |\n\
\n\
> [!MORE]-\n\
> Si lo has estado utilizando durante muchos años, puede haber fragmentos no referenciados - es decir, basura - acumulándose en la base de datos. Por lo tanto, recomendamos reconstruir todo. Probablemente se volverá mucho más pequeño.\n\
>\n\
> Si el volumen de tu bóveda simplemente está aumentando, es mejor reconstruir todo después de organizar los archivos. Self-hosted LiveSync no elimina los datos reales incluso si los eliminas para acelerar el proceso. Está aproximadamente [documentado](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/tech_info.md).\n\
>\n\
> Si no te importa el aumento, puedes aumentar el límite de notificación en 100 MB. Este es el caso si lo estás ejecutando en tu propio servidor. Sin embargo, es mejor reconstruir todo de vez en cuando.\n\
>\n\
\n\
> [!WARNING]\n\
> Si realizas la reconstrucción completa, asegúrate de que todos los dispositivos estén sincronizados. El complemento fusionará tanto como sea posible, sin embargo.\n\
",
        "moduleCheckRemoteSize.optionIncreaseLimit": "aumentar a ${newMax}MB",
        "moduleCheckRemoteSize.optionRebuildAll": "Reconstruir todo ahora",
        "moduleCheckRemoteSize.optionDismiss": "Descartar",
        "moduleCheckRemoteSize.msgConfirmRebuild":
            "Esto puede llevar un poco de tiempo. ¿Realmente quieres reconstruir todo ahora?",
        "moduleCheckRemoteSize.logThresholdEnlarged": "El umbral se ha ampliado a ${size}MB",
        "moduleCheckRemoteSize.logExceededWarning":
            "Tamaño del almacenamiento remoto: ${measuredSize} superó ${notifySize}",
        "moduleCheckRemoteSize.logCurrentStorageSize": "Tamaño del almacenamiento remoto: ${measuredSize}",
        "moduleInputUIObsidian.defaultTitleConfirmation": "Confirmación",
        "moduleInputUIObsidian.optionYes": "Sí",
        "moduleInputUIObsidian.optionNo": "No",
        "moduleInputUIObsidian.defaultTitleSelect": "Seleccionar",
        "moduleLiveSyncMain.optionKeepLiveSyncDisabled": "Mantener LiveSync desactivado",
        "moduleLiveSyncMain.optionResumeAndRestart": "Reanudar y reiniciar Obsidian",
        "moduleLiveSyncMain.msgScramEnabled":
            "Self-hosted LiveSync se ha configurado para ignorar algunos eventos. ¿Es esto correcto?\n\
\n\
| Tipo | Estado | Nota |\n\
|:---:|:---:|---|\n\
| Eventos de almacenamiento | ${fileWatchingStatus} | Se ignorará cada modificación |\n\
| Eventos de base de datos | ${parseReplicationStatus} | Cada cambio sincronizado se pospondrá |\n\
\n\
¿Quieres reanudarlos y reiniciar Obsidian?\n\
\n\
> [!DETAILS]-\n\
> Estas banderas son establecidas por el complemento mientras se reconstruye o se obtiene. Si el proceso termina de forma anormal, puede mantenerse sin querer.\n\
> Si no estás seguro, puedes intentar volver a ejecutar estos procesos. Asegúrate de hacer una copia de seguridad de tu bóveda.\n\
",
        "moduleLiveSyncMain.titleScramEnabled": "Scram habilitado",
        "moduleLiveSyncMain.logAdditionalSafetyScan": "Escanéo de seguridad adicional...",
        "moduleLiveSyncMain.logSafetyScanFailed": "El escaneo de seguridad adicional ha fallado en un módulo",
        "moduleLiveSyncMain.logSafetyScanCompleted": "Escanéo de seguridad adicional completado",
        "moduleLiveSyncMain.logLoadingPlugin": "Cargando complemento...",
        "moduleLiveSyncMain.logPluginInitCancelled": "La inicialización del complemento fue cancelada por un módulo",
        "moduleLiveSyncMain.logPluginVersion": "Self-hosted LiveSync v${manifestVersion} ${packageVersion}",
        "moduleLiveSyncMain.logReadChangelog": "LiveSync se ha actualizado, ¡por favor lee el registro de cambios!",
        "moduleLiveSyncMain.logVersionUpdate":
            "LiveSync se ha actualizado, en caso de actualizaciones que rompan, toda la sincronización automática se ha desactivado temporalmente. Asegúrate de que todos los dispositivos estén actualizados antes de habilitar.",
        "moduleLiveSyncMain.logUnloadingPlugin": "Descargando complemento...",
        "obsidianLiveSyncSettingTab.levelPowerUser": " (experto)",
        "obsidianLiveSyncSettingTab.levelAdvanced": " (avanzado)",
        "obsidianLiveSyncSettingTab.levelEdgeCase": " (excepción)",
        "obsidianLiveSyncSettingTab.logEstimatedSize": "Tamaño estimado: ${size}",
        "obsidianLiveSyncSettingTab.msgSettingModified":
            'La configuración "${setting}" fue modificada desde otro dispositivo. Haz clic {HERE} para recargar la configuración. Haz clic en otro lugar para ignorar los cambios.',
        "obsidianLiveSyncSettingTab.optionHere": "AQUÍ",
        "obsidianLiveSyncSettingTab.logPassphraseInvalid": "La frase de contraseña no es válida, por favor corrígela.",
        "obsidianLiveSyncSettingTab.optionFetchFromRemote": "Obtener del remoto",
        "obsidianLiveSyncSettingTab.optionRebuildBoth": "Reconstructuir ambos desde este dispositivo",
        "obsidianLiveSyncSettingTab.optionSaveOnlySettings": "(Peligro) Guardar solo configuración",
        "obsidianLiveSyncSettingTab.optionCancel": "Cancelar",
        "obsidianLiveSyncSettingTab.titleRebuildRequired": "Reconstrucción necesaria",
        "obsidianLiveSyncSettingTab.msgRebuildRequired":
            "Es necesario reconstruir las bases de datos para aplicar los cambios. Por favor selecciona el método para aplicar los cambios.\n\
\n\
<details>\n\
<summary>Legendas</summary>\n\
\n\
| Símbolo | Significado |\n\
|: ------ :| ------- |\n\
| ⇔ | Actualizado |\n\
| ⇄ | Sincronizar para equilibrar |\n\
| ⇐,⇒ | Transferir para sobrescribir |\n\
| ⇠,⇢ | Transferir para sobrescribir desde otro lado |\n\
\n\
</details>\n\
\n\
## ${OPTION_REBUILD_BOTH}\n\
A simple vista:  📄 ⇒¹ 💻 ⇒² 🛰️ ⇢ⁿ 💻 ⇄ⁿ⁺¹ 📄\n\
Reconstruir tanto la base de datos local como la remota utilizando los archivos existentes de este dispositivo.\n\
Esto bloquea a otros dispositivos, y necesitan realizar la obtención.\n\
## ${OPTION_FETCH}\n\
A simple vista: 📄 ⇄² 💻 ⇐¹ 🛰️ ⇔ 💻 ⇔ 📄\n\
Inicializa la base de datos local y la reconstruye utilizando los datos obtenidos de la base de datos remota.\n\
Este caso incluye el caso en el que has reconstruido la base de datos remota.\n\
## ${OPTION_ONLY_SETTING}\n\
Almacena solo la configuración. **Precaución: esto puede provocar corrupción de datos**; generalmente es necesario reconstruir la base de datos.",
        "obsidianLiveSyncSettingTab.msgAreYouSureProceed": "¿Estás seguro de proceder?",
        "obsidianLiveSyncSettingTab.msgChangesNeedToBeApplied": "¡Los cambios deben aplicarse!",
        "obsidianLiveSyncSettingTab.optionApply": "Aplicar",
        "obsidianLiveSyncSettingTab.logCheckPassphraseFailed":
            "ERROR: Error al comprobar la frase de contraseña con el servidor remoto: \n\
${db}.",
        "obsidianLiveSyncSettingTab.logDatabaseConnected": "Base de datos conectada",
        "obsidianLiveSyncSettingTab.logPassphraseNotCompatible":
            "ERROR: ¡La frase de contraseña no es compatible con el servidor remoto! ¡Por favor, revísala de nuevo!",
        "obsidianLiveSyncSettingTab.logEncryptionNoPassphrase":
            "No puedes habilitar el cifrado sin una frase de contraseña",
        "obsidianLiveSyncSettingTab.logEncryptionNoSupport": "Tu dispositivo no admite el cifrado.",
        "obsidianLiveSyncSettingTab.logRebuildNote":
            "La sincronización ha sido desactivada, obtén y vuelve a activar si lo deseas.",
        "obsidianLiveSyncSettingTab.panelChangeLog": "Registro de cambios",
        "obsidianLiveSyncSettingTab.msgNewVersionNote":
            "¿Aquí debido a una notificación de actualización? Por favor, revise el historial de versiones. Si está satisfecho, haga clic en el botón. Una nueva actualización volverá a mostrar esto.",
        "obsidianLiveSyncSettingTab.optionOkReadEverything": "OK, he leído todo.",
        "obsidianLiveSyncSettingTab.panelSetup": "Configuración",
        "obsidianLiveSyncSettingTab.titleQuickSetup": "Configuración rápida",
        "obsidianLiveSyncSettingTab.nameConnectSetupURI": "Conectar con URI de configuración",
        "obsidianLiveSyncSettingTab.descConnectSetupURI":
            "Este es el método recomendado para configurar Self-hosted LiveSync con una URI de configuración.",
        "obsidianLiveSyncSettingTab.btnUse": "Usar",
        "obsidianLiveSyncSettingTab.nameManualSetup": "Configuración manual",
        "obsidianLiveSyncSettingTab.descManualSetup": "No recomendado, pero útil si no tienes una URI de configuración",
        "obsidianLiveSyncSettingTab.btnStart": "Iniciar",
        "obsidianLiveSyncSettingTab.nameEnableLiveSync": "Activar LiveSync",
        "obsidianLiveSyncSettingTab.descEnableLiveSync":
            "Solo habilita esto después de configurar cualquiera de las dos opciones anteriores o completar toda la configuración manualmente.",
        "obsidianLiveSyncSettingTab.btnEnable": "Activar",
        "obsidianLiveSyncSettingTab.titleSetupOtherDevices": "Para configurar otros dispositivos",
        "obsidianLiveSyncSettingTab.nameCopySetupURI": "Copiar la configuración actual a una URI de configuración",
        "obsidianLiveSyncSettingTab.descCopySetupURI": "¡Perfecto para configurar un nuevo dispositivo!",
        "obsidianLiveSyncSettingTab.btnCopy": "Copiar",
        "obsidianLiveSyncSettingTab.titleReset": "Reiniciar",
        "obsidianLiveSyncSettingTab.nameDiscardSettings": "Descartar configuraciones y bases de datos existentes",
        "obsidianLiveSyncSettingTab.btnDiscard": "Descartar",
        "obsidianLiveSyncSettingTab.msgDiscardConfirmation":
            "¿Realmente deseas descartar las configuraciones y bases de datos existentes?",
        "obsidianLiveSyncSettingTab.titleExtraFeatures": "Habilitar funciones extras y avanzadas",
        "obsidianLiveSyncSettingTab.titleOnlineTips": "Consejos en línea",
        "obsidianLiveSyncSettingTab.linkTroubleshooting": "/docs/es/troubleshooting.md",
        "obsidianLiveSyncSettingTab.linkOpenInBrowser": "Abrir en el navegador",
        "obsidianLiveSyncSettingTab.logErrorOccurred": "¡Ocurrió un error!",
        "obsidianLiveSyncSettingTab.linkTipsAndTroubleshooting": "Consejos y solución de problemas",
        "obsidianLiveSyncSettingTab.linkPageTop": "Ir arriba",
        "obsidianLiveSyncSettingTab.panelGeneralSettings": "Configuraciones Generales",
        "obsidianLiveSyncSettingTab.titleAppearance": "Apariencia",
        "obsidianLiveSyncSettingTab.defaultLanguage": "Predeterminado",
        "obsidianLiveSyncSettingTab.titleLogging": "Registro",
        "obsidianLiveSyncSettingTab.btnNext": "Siguiente",
        "obsidianLiveSyncSettingTab.logCheckingDbConfig": "Verificando la configuración de la base de datos",
        "obsidianLiveSyncSettingTab.logCannotUseCloudant": "Esta función no se puede utilizar con IBM Cloudant.",
        "obsidianLiveSyncSettingTab.btnFix": "Corregir",
        "obsidianLiveSyncSettingTab.logCouchDbConfigSet":
            "Configuración de CouchDB: ${title} -> Establecer ${key} en ${value}",
        "obsidianLiveSyncSettingTab.logCouchDbConfigUpdated":
            "Configuración de CouchDB: ${title} actualizado correctamente",
        "obsidianLiveSyncSettingTab.logCouchDbConfigFail": "Configuración de CouchDB: ${title} falló",
        "obsidianLiveSyncSettingTab.msgNotice": "---Aviso---",
        "obsidianLiveSyncSettingTab.msgIfConfigNotPersistent":
            "Si la configuración del servidor no es persistente (por ejemplo, ejecutándose en docker), los valores aquí pueden cambiar. Una vez que puedas conectarte, por favor actualiza las configuraciones en el local.ini del servidor.",
        "obsidianLiveSyncSettingTab.msgConfigCheck": "--Verificación de configuración--",
        "obsidianLiveSyncSettingTab.warnNoAdmin": "⚠ No tienes privilegios de administrador.",
        "obsidianLiveSyncSettingTab.okAdminPrivileges": "✔ Tienes privilegios de administrador.",
        "obsidianLiveSyncSettingTab.errRequireValidUser": "❗ chttpd.require_valid_user es incorrecto.",
        "obsidianLiveSyncSettingTab.msgSetRequireValidUser": "Configurar chttpd.require_valid_user = true",
        "obsidianLiveSyncSettingTab.okRequireValidUser": "✔ chttpd.require_valid_user está correcto.",
        "obsidianLiveSyncSettingTab.errRequireValidUserAuth": "❗ chttpd_auth.require_valid_user es incorrecto.",
        "obsidianLiveSyncSettingTab.msgSetRequireValidUserAuth": "Configurar chttpd_auth.require_valid_user = true",
        "obsidianLiveSyncSettingTab.okRequireValidUserAuth": "✔ chttpd_auth.require_valid_user está correcto.",
        "obsidianLiveSyncSettingTab.errMissingWwwAuth": "❗ httpd.WWW-Authenticate falta",
        "obsidianLiveSyncSettingTab.msgSetWwwAuth": "Configurar httpd.WWW-Authenticate",
        "obsidianLiveSyncSettingTab.okWwwAuth": "✔ httpd.WWW-Authenticate está correcto.",
        "obsidianLiveSyncSettingTab.errEnableCors": "❗ httpd.enable_cors es incorrecto",
        "obsidianLiveSyncSettingTab.msgEnableCors": "Configurar httpd.enable_cors",
        "obsidianLiveSyncSettingTab.okEnableCors": "✔ httpd.enable_cors está correcto.",
        "obsidianLiveSyncSettingTab.errMaxRequestSize": "❗ chttpd.max_http_request_size es bajo)",
        "obsidianLiveSyncSettingTab.msgSetMaxRequestSize": "Configurar chttpd.max_http_request_size",
        "obsidianLiveSyncSettingTab.okMaxRequestSize": "✔ chttpd.max_http_request_size está correcto.",
        "obsidianLiveSyncSettingTab.errMaxDocumentSize": "❗ couchdb.max_document_size es bajo)",
        "obsidianLiveSyncSettingTab.msgSetMaxDocSize": "Configurar couchdb.max_document_size",
        "obsidianLiveSyncSettingTab.okMaxDocumentSize": "✔ couchdb.max_document_size está correcto.",
        "obsidianLiveSyncSettingTab.errCorsCredentials": "❗ cors.credentials es incorrecto",
        "obsidianLiveSyncSettingTab.msgSetCorsCredentials": "Configurar cors.credentials",
        "obsidianLiveSyncSettingTab.okCorsCredentials": "✔ cors.credentials está correcto.",
        "obsidianLiveSyncSettingTab.okCorsOrigins": "✔ cors.origins está correcto.",
        "obsidianLiveSyncSettingTab.errCorsOrigins": "❗ cors.origins es incorrecto",
        "obsidianLiveSyncSettingTab.msgSetCorsOrigins": "Configurar cors.origins",
        "obsidianLiveSyncSettingTab.msgConnectionCheck": "--Verificación de conexión--",
        "obsidianLiveSyncSettingTab.msgCurrentOrigin": "Origen actual: {origin}",
        "obsidianLiveSyncSettingTab.msgOriginCheck": "Verificación de origen: {org}",
        "obsidianLiveSyncSettingTab.errCorsNotAllowingCredentials": "CORS no permite credenciales",
        "obsidianLiveSyncSettingTab.okCorsCredentialsForOrigin": "CORS credenciales OK",
        "obsidianLiveSyncSettingTab.warnCorsOriginUnmatched": "⚠ El origen de CORS no coincide: {from}->{to}",
        "obsidianLiveSyncSettingTab.okCorsOriginMatched": "✔ Origen de CORS correcto",
        "obsidianLiveSyncSettingTab.msgDone": "--Hecho--",
        "obsidianLiveSyncSettingTab.msgConnectionProxyNote":
            "Si tienes problemas con la verificación de conexión (incluso después de verificar la configuración), por favor verifica la configuración de tu proxy reverso.",
        "obsidianLiveSyncSettingTab.logCheckingConfigDone": "Verificación de configuración completada",
        "obsidianLiveSyncSettingTab.errAccessForbidden": "Acceso prohibido.",
        "obsidianLiveSyncSettingTab.errCannotContinueTest": "No se pudo continuar con la prueba.",
        "obsidianLiveSyncSettingTab.logCheckingConfigFailed": "La verificación de configuración falló",
        "obsidianLiveSyncSettingTab.panelRemoteConfiguration": "Configuración remota",
        "obsidianLiveSyncSettingTab.titleRemoteServer": "Servidor remoto",
        "obsidianLiveSyncSettingTab.optionCouchDB": "CouchDB",
        "obsidianLiveSyncSettingTab.optionMinioS3R2": "Minio,S3,R2",
        "obsidianLiveSyncSettingTab.titleMinioS3R2": "Minio,S3,R2",
        "obsidianLiveSyncSettingTab.msgObjectStorageWarning":
            "ADVERTENCIA: Esta característica está en desarrollo, así que por favor ten en cuenta lo siguiente:\n\
- Arquitectura de solo anexado. Se requiere una reconstrucción para reducir el almacenamiento.\n\
- Un poco frágil.\n\
- Al sincronizar por primera vez, todo el historial será transferido desde el remoto. Ten en cuenta los límites de datos y las velocidades lentas.\n\
- Solo las diferencias se sincronizan en vivo.\n\
\n\
Si encuentras algún problema o tienes ideas sobre esta característica, por favor crea un issue en GitHub.\n\
Aprecio mucho tu gran dedicación.",
        "obsidianLiveSyncSettingTab.nameTestConnection": "Probar conexión",
        "obsidianLiveSyncSettingTab.btnTest": "Probar",
        "obsidianLiveSyncSettingTab.nameApplySettings": "Aplicar configuraciones",
        "obsidianLiveSyncSettingTab.titleCouchDB": "CouchDB",
        "obsidianLiveSyncSettingTab.msgNonHTTPSWarning":
            "No se puede conectar a URI que no sean HTTPS. Por favor, actualiza tu configuración y vuelve a intentarlo.",
        "obsidianLiveSyncSettingTab.msgNonHTTPSInfo":
            "Configurado como URI que no es HTTPS. Ten en cuenta que esto puede no funcionar en dispositivos móviles.",
        "obsidianLiveSyncSettingTab.msgSettingsUnchangeableDuringSync":
            'Estas configuraciones no se pueden cambiar durante la sincronización. Por favor, deshabilita toda la sincronización en las "Configuraciones de Sincronización" para desbloquear.',
        "obsidianLiveSyncSettingTab.nameTestDatabaseConnection": "Probar Conexión de Base de Datos",
        "obsidianLiveSyncSettingTab.descTestDatabaseConnection":
            "Abrir conexión a la base de datos. Si no se encuentra la base de datos remota y tienes permiso para crear una base de datos, se creará la base de datos.",
        "obsidianLiveSyncSettingTab.nameValidateDatabaseConfig": "Validar Configuración de la Base de Datos",
        "obsidianLiveSyncSettingTab.descValidateDatabaseConfig":
            "Verifica y soluciona cualquier problema potencial con la configuración de la base de datos.",
        "obsidianLiveSyncSettingTab.btnCheck": "Verificar",
        "obsidianLiveSyncSettingTab.titleNotification": "Notificación",
        "obsidianLiveSyncSettingTab.panelPrivacyEncryption": "Privacidad y Cifrado",
        "obsidianLiveSyncSettingTab.titleFetchSettings": "Obtener configuraciones",
        "obsidianLiveSyncSettingTab.titleFetchConfigFromRemote": "Obtener configuración del servidor remoto",
        "obsidianLiveSyncSettingTab.descFetchConfigFromRemote":
            "Obtener las configuraciones necesarias del servidor remoto ya configurado.",
        "obsidianLiveSyncSettingTab.buttonFetch": "Obtener",
        "obsidianLiveSyncSettingTab.buttonNext": "Siguiente",
        "obsidianLiveSyncSettingTab.msgConfigCheckFailed":
            "La verificación de configuración ha fallado. ¿Quieres continuar de todos modos?",
        "obsidianLiveSyncSettingTab.titleRemoteConfigCheckFailed": "La verificación de configuración remota falló",
        "obsidianLiveSyncSettingTab.msgEnableEncryptionRecommendation":
            "Recomendamos habilitar el cifrado de extremo a extremo y la obfuscación de ruta. ¿Estás seguro de querer continuar sin cifrado?",
        "obsidianLiveSyncSettingTab.titleEncryptionNotEnabled": "El cifrado no está habilitado",
        "obsidianLiveSyncSettingTab.msgInvalidPassphrase":
            "Tu frase de contraseña de cifrado podría ser inválida. ¿Estás seguro de querer continuar?",
        "obsidianLiveSyncSettingTab.titleEncryptionPassphraseInvalid": "La frase de contraseña de cifrado es inválida",
        "obsidianLiveSyncSettingTab.msgFetchConfigFromRemote": "¿Quieres obtener la configuración del servidor remoto?",
        "obsidianLiveSyncSettingTab.titleFetchConfig": "Obtener configuración",
        "obsidianLiveSyncSettingTab.titleSyncSettings": "Configuraciones de Sincronización",
        "obsidianLiveSyncSettingTab.btnGotItAndUpdated": "Lo entendí y actualicé.",
        "obsidianLiveSyncSettingTab.msgSelectAndApplyPreset":
            "Por favor, selecciona y aplica cualquier elemento preestablecido para completar el asistente.",
        "obsidianLiveSyncSettingTab.titleSynchronizationPreset": "Preestablecimiento de sincronización",
        "obsidianLiveSyncSettingTab.optionLiveSync": "LiveSync",
        "obsidianLiveSyncSettingTab.optionPeriodicWithBatch": "Periódico con lote",
        "obsidianLiveSyncSettingTab.optionDisableAllAutomatic": "Desactivar lo automático",
        "obsidianLiveSyncSettingTab.btnApply": "Aplicar",
        "obsidianLiveSyncSettingTab.logSelectAnyPreset": "Selecciona cualquier preestablecido.",
        "obsidianLiveSyncSettingTab.logConfiguredLiveSync":
            "Modo de sincronización configurado: Sincronización en Vivo",
        "obsidianLiveSyncSettingTab.logConfiguredPeriodic": "Modo de sincronización configurado: Periódico",
        "obsidianLiveSyncSettingTab.logConfiguredDisabled": "Modo de sincronización configurado: DESACTIVADO",
        "obsidianLiveSyncSettingTab.msgGenerateSetupURI":
            "¡Todo listo! ¿Quieres generar un URI de configuración para configurar otros dispositivos?",
        "obsidianLiveSyncSettingTab.titleCongratulations": "¡Felicidades!",
        "obsidianLiveSyncSettingTab.titleSynchronizationMethod": "Método de sincronización",
        "obsidianLiveSyncSettingTab.optionOnEvents": "En eventos",
        "obsidianLiveSyncSettingTab.optionPeriodicAndEvents": "Periódico y en eventos",
        "obsidianLiveSyncSettingTab.titleUpdateThinning": "Actualización de adelgazamiento",
        "obsidianLiveSyncSettingTab.titleDeletionPropagation": "Propagación de eliminación",
        "obsidianLiveSyncSettingTab.titleConflictResolution": "Resolución de conflictos",
        "obsidianLiveSyncSettingTab.titleSyncSettingsViaMarkdown":
            "Configuración de sincronización a través de Markdown",
        "obsidianLiveSyncSettingTab.titleHiddenFiles": "Archivos ocultos",
        "obsidianLiveSyncSettingTab.labelEnabled": "🔁 : Activado",
        "obsidianLiveSyncSettingTab.labelDisabled": "⏹️ : Desactivado",
        "obsidianLiveSyncSettingTab.nameHiddenFileSynchronization": "Sincronización de archivos ocultos",
        "obsidianLiveSyncSettingTab.nameDisableHiddenFileSync": "Desactivar sincronización de archivos ocultos",
        "obsidianLiveSyncSettingTab.btnDisable": "Desactivar",
        "obsidianLiveSyncSettingTab.nameEnableHiddenFileSync": "Activar sincronización de archivos ocultos",
        "Enable advanced features": "Habilitar características avanzadas",
        "Enable poweruser features": "Habilitar funciones para usuarios avanzados",
        "Enable edge case treatment features": "Habilitar manejo de casos límite",
        "lang-de": "Alemán",
        "lang-es": "Español",
        "lang-ja": "Japonés",
        "lang-ru": "Ruso",
        "lang-zh": "Chino simplificado",
        "lang-zh-tw": "Chino tradicional",
        "Display Language": "Idioma de visualización",
        'Not all messages have been translated. And, please revert to "Default" when reporting errors.':
            'No todos los mensajes están traducidos. Por favor, vuelva a "Predeterminado" al reportar errores.',
        "Show status inside the editor": "Mostrar estado dentro del editor",
        "Requires restart of Obsidian.": "Requiere reiniciar Obsidian",
        "Show status as icons only": "Mostrar estado solo con íconos",
        "Show status on the status bar": "Mostrar estado en la barra de estado",
        "Show only notifications": "Mostrar solo notificaciones",
        "Disables logging, only shows notifications. Please disable if you report an issue.":
            "Desactiva registros, solo muestra notificaciones. Desactívelo si reporta un problema.",
        "Verbose Log": "Registro detallado",
        "Show verbose log. Please enable if you report an issue.":
            "Mostrar registro detallado. Actívelo si reporta un problema.",
        "Remote Type": "Tipo de remoto",
        "Remote server type": "Tipo de servidor remoto",
        "Notify when the estimated remote storage size exceeds on start up":
            "Notificar cuando el tamaño estimado del almacenamiento remoto exceda al iniciar",
        "MB (0 to disable).": "MB (0 para desactivar)",
        "End-to-End Encryption": "Cifrado de extremo a extremo",
        "Encrypt contents on the remote database. If you use the plugin's synchronization feature, enabling this is recommended.":
            "Cifrar contenido en la base de datos remota. Se recomienda habilitar si usa la sincronización del plugin.",
        Passphrase: "Frase de contraseña",
        "Encryption phassphrase. If changed, you should overwrite the server's database with the new (encrypted) files.":
            "Frase de cifrado. Si la cambia, sobrescriba la base del servidor con los nuevos archivos cifrados.",
        "Path Obfuscation": "Ofuscación de rutas",
        "Use dynamic iteration count": "Usar conteo de iteraciones dinámico",
        Presets: "Preconfiguraciones",
        "Apply preset configuration": "Aplicar configuración predefinida",
        "Sync Mode": "Modo de sincronización",
        "Periodic Sync interval": "Intervalo de sincronización periódica",
        "Interval (sec)": "Intervalo (segundos)",
        "Sync on Save": "Sincronizar al guardar",
        "Starts synchronisation when a file is saved.": "Inicia sincronización al guardar un archivo",
        "Sync on Editor Save": "Sincronizar al guardar en editor",
        "When you save a file in the editor, start a sync automatically":
            "Iniciar sincronización automática al guardar en editor",
        "Sync on File Open": "Sincronizar al abrir archivo",
        "Forces the file to be synced when opened.": "Forzar sincronización al abrir archivo",
        "Sync on Startup": "Sincronizar al iniciar",
        "Automatically Sync all files when opening Obsidian.":
            "Sincronizar automáticamente todos los archivos al abrir Obsidian",
        "Sync after merging file": "Sincronizar tras fusionar archivo",
        "Sync automatically after merging files": "Sincronizar automáticamente tras fusionar archivos",
        "Batch database update": "Actualización por lotes de BD",
        "Reducing the frequency with which on-disk changes are reflected into the DB":
            "Reducir frecuencia de actualizaciones de disco a BD",
        "Minimum delay for batch database updating": "Retraso mínimo para actualización por lotes",
        "Seconds. Saving to the local database will be delayed until this value after we stop typing or saving.":
            "Segundos. Guardado en BD local se retrasará hasta este valor tras dejar de escribir/guardar",
        "Maximum delay for batch database updating": "Retraso máximo para actualización por lotes",
        "Saving will be performed forcefully after this number of seconds.":
            "Guardado forzado tras esta cantidad de segundos",
        "Use the trash bin": "Usar papelera",
        "Move remotely deleted files to the trash, instead of deleting.":
            "Mover archivos borrados remotos a papelera en lugar de eliminarlos",
        "Keep empty folder": "Mantener carpetas vacías",
        "Should we keep folders that don't have any files inside?": "¿Mantener carpetas vacías?",
        "(BETA) Always overwrite with a newer file": "(BETA) Sobrescribir siempre con archivo más nuevo",
        "Testing only - Resolve file conflicts by syncing newer copies of the file, this can overwrite modified files. Be Warned.":
            "Solo pruebas - Resolver conflictos sincronizando copias nuevas (puede sobrescribir modificaciones)",
        "Delay conflict resolution of inactive files": "Retrasar resolución de conflictos en archivos inactivos",
        "Should we only check for conflicts when a file is opened?": "¿Solo comprobar conflictos al abrir archivo?",
        "Delay merge conflict prompt for inactive files.": "Retrasar aviso de fusión para archivos inactivos",
        "Should we prompt you about conflicting files when a file is opened?":
            "¿Notificar sobre conflictos al abrir archivo?",
        Filename: "Nombre de archivo",
        "Save settings to a markdown file. You will be notified when new settings arrive. You can set different files by the platform.":
            "Guardar configuración en archivo markdown. Se notificarán nuevos ajustes. Puede definir diferentes archivos por plataforma",
        "Write credentials in the file": "Escribir credenciales en archivo",
        "(Not recommended) If set, credentials will be stored in the file.":
            "(No recomendado) Almacena credenciales en el archivo",
        "Notify all setting files": "Notificar todos los archivos de configuración",
        "Suppress notification of hidden files change": "Suprimir notificaciones de cambios en archivos ocultos",
        "If enabled, the notification of hidden files change will be suppressed.":
            "Si se habilita, se suprimirá la notificación de cambios en archivos ocultos.",
        "Scan for hidden files before replication": "Escanear archivos ocultos antes de replicar",
        "Scan hidden files periodically": "Escanear archivos ocultos periódicamente",
        "Seconds, 0 to disable": "Segundos, 0 para desactivar",
        "Maximum file size": "Tamaño máximo de archivo",
        "(MB) If this is set, changes to local and remote files that are larger than this will be skipped. If the file becomes smaller again, a newer one will be used.":
            "(MB) Saltar cambios en archivos locales/remotos mayores a este tamaño. Si se reduce, se usará versión nueva",
        "(Beta) Use ignore files": "(Beta) Usar archivos de ignorar",
        "If this is set, changes to local files which are matched by the ignore files will be skipped. Remote changes are determined using local ignore files.":
            "Saltar cambios en archivos locales que coincidan con ignore files. Cambios remotos usan ignore files locales",
        "Ignore files": "Archivos a ignorar",
        "Comma separated `.gitignore, .dockerignore`": "Separados por comas: `.gitignore, .dockerignore`",
        "Device name": "Nombre del dispositivo",
        "Unique name between all synchronized devices. To edit this setting, please disable customization sync once.":
            "Nombre único entre dispositivos sincronizados. Para editarlo, desactive sincronización de personalización",
        "Per-file-saved customization sync": "Sincronización de personalización por archivo",
        "If enabled per-filed efficient customization sync will be used. We need a small migration when enabling this. And all devices should be updated to v0.23.18. Once we enabled this, we lost a compatibility with old versions.":
            "Habilita sincronización eficiente por archivo. Requiere migración y actualizar todos dispositivos a v0.23.18. Pierde compatibilidad con versiones antiguas",
        "Enable customization sync": "Habilitar sincronización de personalización",
        "Scan customization automatically": "Escanear personalización automáticamente",
        "Scan customization before replicating.": "Escanear personalización antes de replicar",
        "Scan customization periodically": "Escanear personalización periódicamente",
        "Scan customization every 1 minute.": "Escanear personalización cada 1 minuto",
        "Notify customized": "Notificar personalizaciones",
        "Notify when other device has newly customized.": "Notificar cuando otro dispositivo personalice",
        "Write logs into the file": "Escribir logs en archivo",
        "Warning! This will have a serious impact on performance. And the logs will not be synchronised under the default name. Please be careful with logs; they often contain your confidential information.":
            "¡Advertencia! Impacta rendimiento. Los logs no se sincronizan con nombre predeterminado. Contienen información confidencial",
        "Suspend file watching": "Suspender monitorización de archivos",
        "Stop watching for file changes.": "Dejar de monitorear cambios en archivos",
        "Suspend database reflecting": "Suspender reflejo de base de datos",
        "Stop reflecting database changes to storage files.": "Dejar de reflejar cambios de BD en archivos",
        "Memory cache size (by total items)": "Tamaño caché memoria (por ítems)",
        "Memory cache size (by total characters)": "Tamaño caché memoria (por caracteres)",
        "(Mega chars)": "(Millones de caracteres)",
        "Enhance chunk size": "Mejorar tamaño de chunks",
        "Use splitting-limit-capped chunk splitter": "Usar divisor de chunks con límite",
        "If enabled, chunks will be split into no more than 100 items. However, dedupe is slightly weaker.":
            "Divide chunks en máximo 100 ítems. Menos eficiente en deduplicación",
        "Use Segmented-splitter": "Usar divisor segmentado",
        "If this enabled, chunks will be split into semantically meaningful segments. Not all platforms support this feature.":
            "Divide chunks en segmentos semánticos. No todos los sistemas lo soportan",
        "Fetch chunks on demand": "Obtener chunks bajo demanda",
        "(ex. Read chunks online) If this option is enabled, LiveSync reads chunks online directly instead of replicating them locally. Increasing Custom chunk size is recommended.":
            "(Ej: Leer chunks online) Lee chunks directamente en línea. Aumente tamaño de chunks personalizados",
        "Batch size of on-demand fetching": "Tamaño de lote para obtención bajo demanda",
        "The delay for consecutive on-demand fetches": "Retraso entre obtenciones consecutivas",
        "Incubate Chunks in Document": "Incubar chunks en documento",
        "If enabled, newly created chunks are temporarily kept within the document, and graduated to become independent chunks once stabilised.":
            "Chunks nuevos se mantienen temporalmente en el documento hasta estabilizarse",
        "Maximum Incubating Chunks": "Máximo de chunks incubados",
        "The maximum number of chunks that can be incubated within the document. Chunks exceeding this number will immediately graduate to independent chunks.":
            "Número máximo de chunks que pueden incubarse en el documento. Excedentes se independizan",
        "Maximum Incubating Chunk Size": "Tamaño máximo de chunks incubados",
        "The maximum total size of chunks that can be incubated within the document. Chunks exceeding this size will immediately graduate to independent chunks.":
            "Tamaño total máximo de chunks incubados. Excedentes se independizan",
        "Maximum Incubation Period": "Periodo máximo de incubación",
        "The maximum duration for which chunks can be incubated within the document. Chunks exceeding this period will graduate to independent chunks.":
            "Duración máxima para incubar chunks. Excedentes se independizan",
        "Data Compression": "Compresión de datos",
        "Batch size": "Tamaño de lote",
        "Number of changes to sync at a time. Defaults to 50. Minimum is 2.":
            "Número de cambios a sincronizar simultáneamente. Default 50, mínimo 2",
        "Batch limit": "Límite de lotes",
        "Number of batches to process at a time. Defaults to 40. Minimum is 2. This along with batch size controls how many docs are kept in memory at a time.":
            "Número de lotes a procesar. Default 40, mínimo 2. Controla documentos en memoria",
        "Use timeouts instead of heartbeats": "Usar timeouts en lugar de latidos",
        "If this option is enabled, PouchDB will hold the connection open for 60 seconds, and if no change arrives in that time, close and reopen the socket, instead of holding it open indefinitely. Useful when a proxy limits request duration but can increase resource usage.":
            "Mantiene conexión 60s. Si no hay cambios, reinicia socket. Útil con proxies limitantes",
        "Encrypting sensitive configuration items": "Cifrando elementos sensibles",
        "Passphrase of sensitive configuration items": "Frase para elementos sensibles",
        "This passphrase will not be copied to another device. It will be set to `Default` until you configure it again.":
            "Esta frase no se copia a otros dispositivos. Usará `Default` hasta reconfigurar",
        "Enable Developers' Debug Tools.": "Habilitar herramientas de depuración",
        "Requires restart of Obsidian": "Requiere reiniciar Obsidian",
        "Do not keep metadata of deleted files.": "No conservar metadatos de archivos borrados",
        "Delete old metadata of deleted files on start-up": "Borrar metadatos viejos al iniciar",
        "(Days passed, 0 to disable automatic-deletion)": "(Días transcurridos, 0 para desactivar)",
        "Always prompt merge conflicts": "Siempre preguntar en conflictos",
        "Should we prompt you for every single merge, even if we can safely merge automatcially?":
            "¿Preguntar en cada fusión aunque sea automática?",
        "Apply Latest Change if Conflicting": "Aplicar último cambio en conflictos",
        "Enable this option to automatically apply the most recent change to documents even when it conflicts":
            "Aplicar cambios recientes automáticamente aunque generen conflictos",
        "(Obsolete) Use an old adapter for compatibility": "(Obsoleto) Usar adaptador antiguo",
        "Before v0.17.16, we used an old adapter for the local database. Now the new adapter is preferred. However, it needs local database rebuilding. Please disable this toggle when you have enough time. If leave it enabled, also while fetching from the remote database, you will be asked to disable this.":
            "Antes de v0.17.16 usábamos adaptador antiguo. Nuevo adaptador requiere reconstruir BD local. Desactive cuando pueda",
        "Compute revisions for chunks (Previous behaviour)":
            "Calcular revisiones para chunks (comportamiento anterior)",
        "If this enabled, all chunks will be stored with the revision made from its content. (Previous behaviour)":
            "Si se habilita, todos los chunks se almacenan con la revisión hecha desde su contenido. (comportamiento anterior)",
        "Handle files as Case-Sensitive": "Manejar archivos como sensibles a mayúsculas",
        "If this enabled, All files are handled as case-Sensitive (Previous behaviour).":
            "Si se habilita, todos los archivos se manejan como sensibles a mayúsculas (comportamiento anterior)",
        "Scan changes on customization sync": "Escanear cambios en sincronización de personalización",
        "Do not use internal API": "No usar API interna",
        "Database suffix": "Sufijo de base de datos",
        "LiveSync could not handle multiple vaults which have same name without different prefix, This should be automatically configured.":
            "LiveSync no puede manejar múltiples bóvedas con mismo nombre sin prefijo. Se configura automáticamente",
        "The Hash algorithm for chunk IDs": "Algoritmo hash para IDs de chunks",
        "Fetch database with previous behaviour": "Obtener BD con comportamiento anterior",
        "Do not split chunks in the background": "No dividir chunks en segundo plano",
        "If disabled(toggled), chunks will be split on the UI thread (Previous behaviour).":
            "Si se desactiva, chunks se dividen en hilo UI (comportamiento anterior)",
        "Process small files in the foreground": "Procesar archivos pequeños en primer plano",
        "If enabled, the file under 1kb will be processed in the UI thread.": "Archivos <1kb se procesan en hilo UI",
        "Do not check configuration mismatch before replication": "No verificar incompatibilidades antes de replicar",
        "Endpoint URL": "URL del endpoint",
        "Access Key": "Clave de acceso",
        "Secret Key": "Clave secreta",
        Region: "Región",
        "Bucket Name": "Nombre del bucket",
        "Use Custom HTTP Handler": "Usar manejador HTTP personalizado",
        "Enable this if your Object Storage doesn't support CORS": "Habilitar si su almacenamiento no soporta CORS",
        "Server URI": "URI del servidor",
        Username: "Usuario",
        username: "nombre de usuario",
        Password: "Contraseña",
        password: "contraseña",
        "Database Name": "Nombre de la base de datos",
        "logPane.title": "Registro de Self-hosted LiveSync",
        "logPane.wrap": "Ajustar",
        "logPane.autoScroll": "Autodesplazamiento",
        "logPane.pause": "Pausar",
        "logPane.logWindowOpened": "Ventana de registro abierta",
        "cmdConfigSync.showCustomizationSync": "Mostrar sincronización de personalización",
        "moduleObsidianMenu.replicate": "Replicar",
        "moduleLog.showLog": "Mostrar registro",
        "liveSyncReplicator.replicationInProgress": "Replicación en curso",
        "liveSyncReplicator.oneShotSyncBegin": "Inicio de sincronización OneShot... (${syncMode})",
        "liveSyncReplicator.couldNotConnectToServer": "No se pudo conectar al servidor.",
        "liveSyncReplicator.checkingLastSyncPoint": "Buscando el último punto sincronizado.",
        "liveSyncReplicator.cantReplicateLowerValue": "No podemos replicar un valor más bajo.",
        "liveSyncReplicator.retryLowerBatchSize":
            "Reintentar con tamaño de lote más bajo:${batch_size}/${batches_limit}",
        "liveSyncReplicator.beforeLiveSync": "Antes de LiveSync, inicia OneShot...",
        "liveSyncReplicator.liveSyncBegin": "Inicio de LiveSync...",
        "liveSyncReplicator.couldNotConnectToRemoteDb": "No se pudo conectar a base de datos remota: ${d}",
        "liveSyncReplicator.couldNotConnectToURI": "No se pudo conectar a ${uri}:${dbRet}",
        "liveSyncReplicator.couldNotConnectTo":
            "No se pudo conectar a ${uri} : ${name} \n\
(${db})",
        "liveSyncReplicator.remoteDbCorrupted":
            "La base de datos remota es más nueva o está dañada, asegúrese de tener la última versión de self-hosted-livesync instalada",
        "liveSyncReplicator.lockRemoteDb": "Bloquear base de datos remota para prevenir corrupción de datos",
        "liveSyncReplicator.unlockRemoteDb": "Desbloquear base de datos remota para prevenir corrupción de datos",
        "liveSyncReplicator.replicationClosed": "Replicación cerrada",
        "liveSyncReplicator.remoteDbDestroyed": "Base de datos remota destruida",
        "liveSyncReplicator.remoteDbDestroyError": "Algo ocurrió al destruir base de datos remota:",
        "liveSyncReplicator.remoteDbCreatedOrConnected": "Base de datos remota creada o conectada",
        "liveSyncReplicator.markDeviceResolved": "Marcar este dispositivo como 'resuelto'.",
        "liveSyncReplicator.remoteDbMarkedResolved": "Base de datos remota marcada como resuelta.",
        "liveSyncReplicator.couldNotMarkResolveRemoteDb": "No se pudo marcar como resuelta la base de datos remota.",
        "liveSyncSetting.errorNoSuchSettingItem": "No existe el ajuste: ${key}",
        "liveSyncSetting.valueShouldBeInRange": "El valor debe estar entre ${min} y ${max}",
        "liveSyncSettings.btnApply": "Aplicar",
        "liveSyncSetting.originalValue": "Original: ${value}",
    },
} as const;
