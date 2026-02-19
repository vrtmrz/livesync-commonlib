import type { LiveSyncAbstractReplicator } from "@lib/replication/LiveSyncAbstractReplicator";
import { handlers } from "@lib/services/lib/HandlerUtils";
import type { IReplicatorService } from "./IService";
import { ServiceBase, type ServiceContext } from "./ServiceBase";
import type { SettingService } from "./SettingService";
import { createInstanceLogFunction } from "../lib/logUtils";
import type { AppLifecycleService } from "./AppLifecycleService";
import { UnresolvedErrorManager } from "./UnresolvedErrorManager";
import { $msg } from "@lib/common/i18n";
import { yieldMicrotask } from "octagonal-wheels/promises";
import type { DatabaseEventService } from "./DatabaseEventService";
import { LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE } from "@lib/common/logger";
import { RemoteTypes } from "@lib/common/types";
import { DEFAULT_REPLICATION_STATICS } from "../../common/models/shared.definition";
import { reactiveSource } from "octagonal-wheels/dataobject/reactive";

export interface ReplicatorServiceDependencies {
    settingService: SettingService;
    appLifecycleService: AppLifecycleService;
    databaseEventService: DatabaseEventService;
}
/**
 * The ReplicatorService provides methods for managing replication.
 */
export abstract class ReplicatorService<T extends ServiceContext = ServiceContext>
    extends ServiceBase<T>
    implements IReplicatorService
{
    _log = createInstanceLogFunction("ReplicatorService");

    private settingService: SettingService;
    private databaseEventService: DatabaseEventService;
    private _activeReplicator: LiveSyncAbstractReplicator | undefined;
    private _replicatorType: string | undefined;
    _unresolvedErrorManager: UnresolvedErrorManager;
    constructor(
        context: T,
        protected dependencies: ReplicatorServiceDependencies
    ) {
        super(context);
        this._unresolvedErrorManager = new UnresolvedErrorManager(dependencies.appLifecycleService);
        this.settingService = dependencies.settingService;
        this.settingService.onRealiseSetting.addHandler(this._initialiseReplicator.bind(this));
        this.databaseEventService = dependencies.databaseEventService;
        this.databaseEventService.onResetDatabase.addHandler(this.disposeReplicator.bind(this));
        this.databaseEventService.onDatabaseInitialisation.addHandler(this.disposeReplicator.bind(this));
        this.databaseEventService.onDatabaseInitialised.addHandler(this._initialiseReplicator.bind(this));
    }

    private async disposeReplicator() {
        this._log("Detect database reset, closing active replicator if exists.");
        if (this._activeReplicator) {
            await this._activeReplicator.closeReplication();
        }
        // To flush e2ee salts, device id, and other information kept in the replicator instance, to avoid potential database corruption after reset.

        this._activeReplicator = undefined;
        this._replicatorType = undefined;
        return true;
    }

    private async _initialiseReplicator() {
        const message = $msg("Replicator.Message.InitialiseFatalError");
        const setting = this.settingService.currentSettings();
        if (!setting) {
            this._activeReplicator = undefined;
            this._replicatorType = undefined;
            this._unresolvedErrorManager.showError(message, LOG_LEVEL_NOTICE);
            return false;
        }
        const replicatorType = setting.remoteType;
        if (replicatorType === this._replicatorType && this._activeReplicator) {
            // No need to change the replicator.
            this._unresolvedErrorManager.clearError(message);
            this._log("Active replicator has been kept", LOG_LEVEL_VERBOSE);
            return true;
        } else {
            this._log("Acquiring new replicator");
            const newReplicator = await this.getNewReplicator();
            if (!newReplicator) {
                this._unresolvedErrorManager.showError(message, LOG_LEVEL_NOTICE);
                return false;
            }
            // Check existing replicator and close it if exists.
            if (this._activeReplicator) {
                await this._activeReplicator.closeReplication();
                this._log("Active replicator closed", LOG_LEVEL_VERBOSE);
            }
            this._activeReplicator = newReplicator;
            this._replicatorType = replicatorType;

            // Reset replication statics when replicator changes.
            this.replicationStatics.value = { ...DEFAULT_REPLICATION_STATICS };
            await yieldMicrotask();
            // Probably we need to clear all synchronising parameters handlers
            // Note that parameters handler keeps an key-deriving salt in memory,
            // so we need to clear them when the replicator changes, to avoid potential database corruption.
            if (!(await this.onReplicatorInitialised())) {
                this._log("Failed to initialise the replicator, onReplicatorInitialised reported some problems.");
                this._activeReplicator = undefined;
                this._replicatorType = undefined;
                this._unresolvedErrorManager.showError(message, LOG_LEVEL_NOTICE);
                return false;
            }
            const remoteTypeDisplay = replicatorType === RemoteTypes.REMOTE_COUCHDB ? "CouchDB" : replicatorType;
            this._log(`Replicator (${remoteTypeDisplay}) initialised and activated`, LOG_LEVEL_VERBOSE);

            this._unresolvedErrorManager.clearError(message);
            return true;
        }
    }

    /**
     * Close the active replication if any.
     * Not used currently.
     */
    readonly onCloseActiveReplication = handlers<IReplicatorService>().anySuccess("onCloseActiveReplication");

    /**
     * Get a new replicator instance based on the provided settings.
     */
    readonly getNewReplicator = handlers<IReplicatorService>().firstResult("getNewReplicator");

    readonly onReplicatorInitialised = handlers<IReplicatorService>().bailFirstFailure("onReplicatorInitialised");

    /**
     * Get the currently active replicator instance.
     * If no active replicator, return undefined but that is the fatal situation (on Obsidian).
     */
    getActiveReplicator(): LiveSyncAbstractReplicator | undefined {
        const message = "No replicator has been activated or has not been initialised yet.";
        if (!this._activeReplicator) {
            this._unresolvedErrorManager.showError(message, LOG_LEVEL_NOTICE);
            return undefined;
        }
        this._unresolvedErrorManager.clearError(message);
        return this._activeReplicator;
    }

    replicationStatics = reactiveSource({ ...DEFAULT_REPLICATION_STATICS });
}
