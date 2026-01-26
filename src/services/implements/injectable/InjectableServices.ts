import { type ServiceInstances } from "@lib/services/ServiceHub.ts";
import type { UIService } from "@lib/services/implements/base/UIService.ts";
import type { ConfigService } from "@lib/services/base/ConfigService.ts";
import type { ServiceContext } from "@lib/services/base/ServiceBase.ts";

import type { InjectableAPIService } from "./InjectableAPIService";
import type { InjectablePathService } from "./InjectablePathService";
import type { InjectableDatabaseService } from "./InjectableDatabaseService";
import type { InjectableDatabaseEventService } from "./InjectableDatabaseEventService";
import type { InjectableReplicatorService } from "./InjectableReplicatorService";
import type { InjectableFileProcessingService } from "./InjectableFileProcessingService";
import type { InjectableReplicationService } from "./InjectableReplicationService";
import type { InjectableRemoteService } from "./InjectableRemoteService";
import type { InjectableConflictService } from "./InjectableConflictService";
import type { InjectableAppLifecycleService } from "./InjectableAppLifecycleService";
import type { InjectableSettingService } from "./InjectableSettingService";
import type { InjectableTweakValueService } from "./InjectableTweakValueService";
import type { InjectableVaultService } from "./InjectableVaultService";
import type { InjectableTestService } from "./InjectableTestService";

export type InjectableServiceInstances<T extends ServiceContext> = ServiceInstances<T> & {
    API?: InjectableAPIService<T>;
    path?: InjectablePathService<T>;
    database?: InjectableDatabaseService<T>;
    databaseEvents?: InjectableDatabaseEventService<T>;
    replicator?: InjectableReplicatorService<T>;
    fileProcessing?: InjectableFileProcessingService<T>;
    replication?: InjectableReplicationService<T>;
    remote?: InjectableRemoteService<T>;
    conflict?: InjectableConflictService<T>;
    appLifecycle?: InjectableAppLifecycleService<T>;
    setting?: InjectableSettingService<T>;
    tweakValue?: InjectableTweakValueService<T>;
    vault?: InjectableVaultService<T>;
    test?: InjectableTestService<T>;
    ui?: UIService<T>;
    config?: ConfigService<T>;
};
