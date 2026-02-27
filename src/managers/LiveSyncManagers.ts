import { LOG_LEVEL_VERBOSE, type EntryDoc } from "../common/types";
import { ContentSplitter } from "../ContentSplitter/ContentSplitters.ts";
import { ChangeManager } from "../managers/ChangeManager.ts";
import { ChunkFetcher } from "../managers/ChunkFetcher.ts";
import { ChunkManager } from "../managers/ChunkManager.ts";
import { ConflictManager } from "../managers/ConflictManager.ts";
import { EntryManager } from "../managers/EntryManager/EntryManager.ts";
import { HashManager } from "../managers/HashManager/HashManager.ts";
import type { APIService } from "../services/base/APIService.ts";
import type { IDatabaseService, IPathService, IReplicatorService, ISettingService } from "../services/base/IService.ts";
import { createInstanceLogFunction, type LogFunction } from "../services/lib/logUtils.ts";

export interface LiveSyncManagersOptions<TSettingService extends ISettingService = ISettingService> {
    database: PouchDB.Database<EntryDoc>;
    databaseService: IDatabaseService;
    settingService: TSettingService;
    pathService: IPathService;
    replicatorService: IReplicatorService;
    APIService: APIService;
}
export class LiveSyncManagers {
    protected _pathService: IPathService;
    protected _replicatorService: IReplicatorService;
    protected _settingService: ISettingService;
    protected _APIService: APIService;

    hashManager: HashManager;
    chunkFetcher: ChunkFetcher;
    changeManager: ChangeManager<EntryDoc>;
    chunkManager: ChunkManager;
    splitter: ContentSplitter;
    entryManager: EntryManager;
    conflictManager: ConflictManager;

    protected options: LiveSyncManagersOptions;
    protected log: LogFunction;
    constructor(options: LiveSyncManagersOptions) {
        this.options = options;
        this._APIService = options.APIService;
        this._pathService = options.pathService;
        this._replicatorService = options.replicatorService;
        this._settingService = options.settingService;
        this.log = createInstanceLogFunction("LiveSyncManagers", this._APIService);
        const { changeManager, hashManager, splitter, chunkManager, chunkFetcher, entryManager, conflictManager } =
            this.getManagerMembers();
        this.changeManager = changeManager;
        this.hashManager = hashManager;
        this.splitter = splitter;
        this.chunkManager = chunkManager;
        this.chunkFetcher = chunkFetcher;
        this.entryManager = entryManager;
        this.conflictManager = conflictManager;
    }

    async teardownManagers() {
        this.log("Teardown LiveSync Managers...", LOG_LEVEL_VERBOSE);
        if (this.changeManager) {
            this.changeManager.teardown();
            this.changeManager = undefined!;
        }
        if (this.chunkFetcher) {
            this.chunkFetcher.destroy();
            this.chunkFetcher = undefined!;
        }
        if (this.chunkManager) {
            this.chunkManager.destroy();
            this.chunkManager = undefined!;
        }
        this.log("Teardown LiveSync Managers... Done");
        return await Promise.resolve();
    }

    protected getManagerMembers() {
        this.log("Creating LiveSync Managers...");
        const database = this.options.databaseService.localDatabase.localDatabase;

        const changeManager = new ChangeManager<EntryDoc>({
            database,
        });

        const hashManager = new HashManager({
            settingService: this.options.settingService,
        });

        const splitter = new ContentSplitter({
            settingService: this.options.settingService,
        });

        const chunkManager = new ChunkManager({
            changeManager: changeManager,
            database,
            settingService: this.options.settingService,
        });
        const chunkFetcher = new ChunkFetcher({
            chunkManager: chunkManager,
            replicatorService: this.options.replicatorService,
            settingService: this.options.settingService,
        });
        const entryManager = new EntryManager({
            database,
            hashManager: hashManager,
            chunkManager: chunkManager,
            splitter: splitter,
            pathService: this._pathService,
            settingService: this.options.settingService,
        });
        const conflictManager = new ConflictManager({
            entryManager: entryManager,
            database,
            pathService: this._pathService,
        });
        this.log("LiveSync Managers have been created");
        return {
            changeManager,
            hashManager,
            splitter,
            chunkManager,
            chunkFetcher,
            entryManager,
            conflictManager,
        };
    }
    async initialise() {
        this.log("Initialising LiveSync Managers...", LOG_LEVEL_VERBOSE);
        await this.splitter.initialise({
            settingService: this.options.settingService,
        });
        await this.hashManager.initialise();
        this.log("LiveSync Manager has been initialised");
    }
    async reinitialise() {
        await this.teardownManagers();

        const { changeManager, hashManager, splitter, chunkManager, chunkFetcher, entryManager, conflictManager } =
            this.getManagerMembers();
        this.changeManager = changeManager;
        this.hashManager = hashManager;
        this.splitter = splitter;
        this.chunkManager = chunkManager;
        this.chunkFetcher = chunkFetcher;
        this.entryManager = entryManager;
        this.conflictManager = conflictManager;
        await this.initialise();
    }

    clearCaches() {
        this.chunkManager?.clearCaches();
    }

    async prepareHashFunction() {
        this.hashManager = new HashManager({
            settingService: this.options.settingService,
        });
        await this.hashManager.initialise();
    }
}
