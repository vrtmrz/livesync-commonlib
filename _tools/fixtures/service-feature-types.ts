import {
    createServiceFeature,
    serviceFeature,
    type NecessaryServices,
    type NecessaryServicesInterfaces,
    type RequiredServices,
    type ServiceFeatureFunction,
    type ServiceModules,
} from "@vrtmrz/livesync-commonlib/compat/interfaces/ServiceModule";
import type { ServiceHub } from "@vrtmrz/livesync-commonlib/compat/services/ServiceHub";
import type { IServiceHub } from "@vrtmrz/livesync-commonlib/compat/services/base/IService";
import type { ServiceContext } from "@vrtmrz/livesync-commonlib/compat/services/base/ServiceBase";
import type { InjectableServiceHub } from "@vrtmrz/livesync-commonlib/compat/services/implements/injectable/InjectableServiceHub";
import type { LogFunction } from "@vrtmrz/livesync-commonlib/compat/services/lib/logUtils";
import {
    performFullScan,
    synchroniseAllFilesBetweenDBandStorage,
    useOfflineScanner,
} from "@vrtmrz/livesync-commonlib/compat/serviceFeatures/offlineScanner";
import {
    prepareDatabaseForUse,
    usePrepareDatabaseForUse,
} from "@vrtmrz/livesync-commonlib/compat/serviceFeatures/prepareDatabaseForUse";
import {
    commandReplicateWithSpecificRemote,
    commandSwitchActiveRemote,
    migrateToMultipleRemoteConfigurations,
    useRemoteConfiguration,
    useRemoteConfigurationMigration,
    type RemoteConfigHost,
} from "@vrtmrz/livesync-commonlib/compat/serviceFeatures/remoteConfig";

type Equal<Left, Right> =
    (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Assert<Value extends true> = Value;

type LegacyHost = NecessaryServices<"appLifecycle", "storageAccess">;
type LegacyServiceKeys = Assert<Equal<keyof LegacyHost["services"], "context" | "appLifecycle">>;
type LegacyModuleKeys = Assert<Equal<keyof LegacyHost["serviceModules"], "storageAccess">>;
type LegacyContext = Assert<Equal<LegacyHost["services"]["context"], ServiceContext>>;
type InterfaceHost = NecessaryServices<"appLifecycle", "storageAccess", IServiceHub>;
type LegacyInterfaceAlias = Assert<Equal<InterfaceHost, NecessaryServicesInterfaces<"appLifecycle", "storageAccess">>>;
type InterfaceServiceKeys = Assert<Equal<keyof InterfaceHost["services"], "appLifecycle">>;

type HostContext = ServiceContext & { readonly notices: { clear(): void } };
type SelectedHub = InjectableServiceHub<HostContext>;
type Dependencies = NecessaryServices<"appLifecycle" | "conflict", never, SelectedHub> & {
    readonly log: LogFunction;
};
type SelectedServiceKeys = Assert<Equal<keyof Dependencies["services"], "context" | "appLifecycle" | "conflict">>;
type NoModuleKeys = Assert<Equal<keyof Dependencies["serviceModules"], never>>;
type ConcreteService = Assert<Equal<Dependencies["services"]["conflict"], SelectedHub["conflict"]>>;
type ExtendedContext = Assert<Equal<Dependencies["services"]["context"], HostContext>>;
type SelectedServices = Assert<
    Equal<RequiredServices<"conflict", SelectedHub>, Pick<SelectedHub, "context" | "conflict">>
>;

declare const dependencies: Dependencies;
dependencies.services.conflict.queueCheckFor.setHandler(async () => {});
dependencies.services.context.notices.clear();
// @ts-expect-error An undeclared service is unavailable through the dependency contract.
dependencies.services.API;
// @ts-expect-error An undeclared ServiceModule is unavailable through the dependency contract.
dependencies.serviceModules.storageAccess;
// @ts-expect-error A borrowed logger does not grant ownership operations.
dependencies.log.dispose();

const feature = (host: Dependencies, open?: () => Promise<void>, options: { readonly label?: string } = {}) => {
    host.log(options.label ?? "ready");
    return {
        open: async () => {
            await open?.();
        },
    };
};
const useFeature = createServiceFeature(feature);
type CompleteSignature = Assert<Equal<typeof useFeature, typeof feature>>;
useFeature(dependencies).open();
useFeature(dependencies, undefined, { label: "selected" }).open();
// @ts-expect-error The logger remains a required dependency after wrapping.
useFeature({ services: dependencies.services, serviceModules: {} });
// @ts-expect-error Optional callbacks retain their original parameter types.
useFeature(dependencies, async (unexpected: string) => {});

declare function genericFeature<Value>(host: { readonly value: Value }): Value;
const useGenericFeature = createServiceFeature(genericFeature);
type GenericSignature = Assert<Equal<typeof useGenericFeature, typeof genericFeature>>;
const numberResult: number = useGenericFeature({ value: 1 });
const stringResult: string = useGenericFeature({ value: "value" });

declare function asynchronousFeature(host: Dependencies): Promise<boolean>;
const useAsynchronousFeature = createServiceFeature(asynchronousFeature);
type AsynchronousSignature = Assert<Equal<typeof useAsynchronousFeature, typeof asynchronousFeature>>;

declare function overloadedFeature(host: { readonly value: string }): string;
declare function overloadedFeature(host: { readonly value: number }): number;
const useOverloadedFeature = createServiceFeature(overloadedFeature);
type OverloadedSignature = Assert<Equal<typeof useOverloadedFeature, typeof overloadedFeature>>;
const overloadedNumber: number = useOverloadedFeature({ value: 1 });
const overloadedString: string = useOverloadedFeature({ value: "value" });

const legacyExplicit = createServiceFeature<"appLifecycle", never, Promise<boolean>>(async (host) => {
    host.services.appLifecycle.isSuspended();
    return true;
});
type LegacyFunction = Assert<
    Equal<typeof legacyExplicit, ServiceFeatureFunction<"appLifecycle", never, Promise<boolean>>>
>;

// Preserve older contextual inference; new definitions declare their dependency type.
const legacyImplicit = createServiceFeature((host) => host.services.appLifecycle.isSuspended());
type LegacyImplicitServices = Assert<Equal<keyof Parameters<typeof legacyImplicit>[0]["services"], keyof ServiceHub>>;
type LegacyImplicitModules = Assert<
    Equal<keyof Parameters<typeof legacyImplicit>[0]["serviceModules"], keyof ServiceModules>
>;

const fromBuilder = serviceFeature<"conflict", never, SelectedHub>().create((host, label = "ready") => {
    host.services.conflict.queueCheckFor.setHandler(async () => {});
    host.services.context.notices.clear();
    return { label };
});
type BuilderService = Assert<Equal<Parameters<typeof fromBuilder>[0]["services"]["conflict"], SelectedHub["conflict"]>>;
fromBuilder(dependencies, "selected").label;
const legacyBuilder = serviceFeature<"appLifecycle", never>().create<boolean>((host) =>
    host.services.appLifecycle.isSuspended()
);
type LegacyBuilderResult = Assert<Equal<ReturnType<typeof legacyBuilder>, boolean>>;
type LegacyCallback = () => boolean;
const legacyCallbackBuilder = serviceFeature<"appLifecycle", never>().create<LegacyCallback>(
    (host) => () => host.services.appLifecycle.isSuspended()
);
type LegacyCallbackResult = Assert<Equal<ReturnType<typeof legacyCallbackBuilder>, LegacyCallback>>;

type SelectedFeatureAlias = ServiceFeatureFunction<"conflict", never, void, SelectedHub>;
const selectedFeature: SelectedFeatureAlias = (host) => {
    host.services.conflict.queueCheckFor.setHandler(async () => {});
};

// @ts-expect-error A dependency key must exist in the selected source.
type MissingService = NecessaryServices<"missing", never, SelectedHub>;
// @ts-expect-error A ServiceModule key must exist in ServiceModules.
type MissingModule = NecessaryServices<"conflict", "missing", SelectedHub>;
// @ts-expect-error A feature helper accepts functions only.
createServiceFeature({ services: dependencies.services });
void [numberResult, stringResult, overloadedNumber, overloadedString, legacyBuilder, selectedFeature];

type OfflineScannerHost = NecessaryServices<
    "API" | "appLifecycle" | "setting" | "vault" | "path" | "database" | "keyValueDB",
    "storageAccess" | "fileHandler"
>;
type OfflineScannerServiceKeys = Assert<
    Equal<
        keyof Parameters<typeof useOfflineScanner>[0]["services"],
        "context" | "API" | "appLifecycle" | "setting" | "vault" | "path" | "database" | "keyValueDB"
    >
>;
type OfflineScannerModuleKeys = Assert<
    Equal<keyof Parameters<typeof useOfflineScanner>[0]["serviceModules"], "storageAccess" | "fileHandler">
>;

type OfflineSyncHost = NecessaryServices<
    "setting" | "vault" | "path" | "database" | "keyValueDB",
    "storageAccess" | "fileHandler"
>;
type OfflineSyncServiceKeys = Assert<
    Equal<
        keyof Parameters<typeof synchroniseAllFilesBetweenDBandStorage>[0]["services"],
        "context" | "setting" | "vault" | "path" | "database" | "keyValueDB"
    >
>;
type OfflineSyncModuleKeys = Assert<
    Equal<
        keyof Parameters<typeof synchroniseAllFilesBetweenDBandStorage>[0]["serviceModules"],
        "storageAccess" | "fileHandler"
    >
>;
type PerformFullScanServiceKeys = Assert<
    Equal<
        keyof Parameters<typeof performFullScan>[0]["services"],
        "context" | "setting" | "vault" | "path" | "database" | "keyValueDB"
    >
>;
type PerformFullScanModuleKeys = Assert<
    Equal<keyof Parameters<typeof performFullScan>[0]["serviceModules"], "storageAccess" | "fileHandler">
>;
declare const offlineScannerHost: OfflineScannerHost;
declare const offlineSyncHost: OfflineSyncHost;
declare const offlineScanLog: Parameters<typeof synchroniseAllFilesBetweenDBandStorage>[1];
declare const offlineScanErrors: Parameters<typeof synchroniseAllFilesBetweenDBandStorage>[2];
declare const offlineScanOptions: Parameters<typeof synchroniseAllFilesBetweenDBandStorage>[3];
useOfflineScanner(offlineScannerHost);
synchroniseAllFilesBetweenDBandStorage(offlineSyncHost, offlineScanLog, offlineScanErrors, offlineScanOptions);
performFullScan(offlineScannerHost, offlineScanLog, offlineScanErrors, {});
performFullScan(offlineScannerHost, offlineScanLog, offlineScanErrors, false, false);

type PrepareDatabaseOperationHost = NecessaryServices<
    "appLifecycle" | "vault" | "database" | "databaseEvents" | "fileProcessing" | "replicator",
    never
>;
type PrepareDatabaseFeatureHost = NecessaryServices<
    "API" | "appLifecycle" | "vault" | "database" | "databaseEvents" | "fileProcessing" | "replicator",
    never
>;
type PrepareDatabaseOperationServiceKeys = Assert<
    Equal<
        keyof Parameters<typeof prepareDatabaseForUse>[0]["services"],
        "context" | "appLifecycle" | "vault" | "database" | "databaseEvents" | "fileProcessing" | "replicator"
    >
>;
type PrepareDatabaseFeatureServiceKeys = Assert<
    Equal<
        keyof Parameters<typeof usePrepareDatabaseForUse>[0]["services"],
        "context" | "API" | "appLifecycle" | "vault" | "database" | "databaseEvents" | "fileProcessing" | "replicator"
    >
>;
type PrepareDatabaseModuleKeys = Assert<
    Equal<keyof Parameters<typeof usePrepareDatabaseForUse>[0]["serviceModules"], never>
>;
declare const prepareDatabaseOperationHost: PrepareDatabaseOperationHost;
declare const prepareDatabaseFeatureHost: PrepareDatabaseFeatureHost;
declare const prepareDatabaseLog: Parameters<typeof prepareDatabaseForUse>[1];
declare const prepareDatabaseErrors: Parameters<typeof prepareDatabaseForUse>[2];
prepareDatabaseForUse(prepareDatabaseOperationHost, prepareDatabaseLog, prepareDatabaseErrors);
usePrepareDatabaseForUse(prepareDatabaseFeatureHost);

type RemoteMigrationHost = NecessaryServices<"API" | "setting", never>;
type RemoteMigrationFeatureHost = NecessaryServices<"API" | "setting" | "appLifecycle", never>;
type RemoteSwitchHost = NecessaryServices<"API" | "setting" | "UI" | "control", never>;
type RemoteReplicationHost = NecessaryServices<"API" | "setting" | "UI" | "control" | "replication", never>;
type RemoteMigrationServiceKeys = Assert<
    Equal<keyof Parameters<typeof migrateToMultipleRemoteConfigurations>[0]["services"], "context" | "API" | "setting">
>;
type RemoteMigrationFeatureServiceKeys = Assert<
    Equal<
        keyof Parameters<typeof useRemoteConfigurationMigration>[0]["services"],
        "context" | "API" | "setting" | "appLifecycle"
    >
>;
type RemoteSwitchServiceKeys = Assert<
    Equal<
        keyof Parameters<typeof commandSwitchActiveRemote>[0]["services"],
        "context" | "API" | "setting" | "UI" | "control"
    >
>;
type RemoteReplicationServiceKeys = Assert<
    Equal<
        keyof Parameters<typeof commandReplicateWithSpecificRemote>[0]["services"],
        "context" | "API" | "setting" | "UI" | "control" | "replication"
    >
>;
type RemoteConfigurationFeatureServiceKeys = Assert<
    Equal<keyof Parameters<typeof useRemoteConfiguration>[0]["services"], keyof RemoteReplicationHost["services"]>
>;
type BroadRemoteConfigHost = NecessaryServices<
    "setting" | "UI" | "replication" | "control" | "appLifecycle" | "API",
    never
>;
type RemoteConfigHostCompatibility = Assert<Equal<RemoteConfigHost, BroadRemoteConfigHost>>;
declare const remoteMigrationHost: RemoteMigrationHost;
declare const remoteMigrationFeatureHost: RemoteMigrationFeatureHost;
declare const remoteSwitchHost: RemoteSwitchHost;
declare const remoteReplicationHost: RemoteReplicationHost;
declare const broadRemoteConfigHost: RemoteConfigHost;
migrateToMultipleRemoteConfigurations(remoteMigrationHost);
useRemoteConfigurationMigration(remoteMigrationFeatureHost);
commandSwitchActiveRemote(remoteSwitchHost);
commandReplicateWithSpecificRemote(remoteReplicationHost);
useRemoteConfiguration(remoteReplicationHost);
migrateToMultipleRemoteConfigurations(broadRemoteConfigHost);
useRemoteConfigurationMigration(broadRemoteConfigHost);
commandSwitchActiveRemote(broadRemoteConfigHost);
commandReplicateWithSpecificRemote(broadRemoteConfigHost);
useRemoteConfiguration(broadRemoteConfigHost);
