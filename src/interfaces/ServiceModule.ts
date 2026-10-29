import type { DatabaseFileAccess } from "@lib/interfaces/DatabaseFileAccess";
import type { Rebuilder } from "@lib/interfaces/DatabaseRebuilder";
import type { IFileHandler } from "@lib/interfaces/FileHandler";
import type { StorageAccess } from "@lib/interfaces/StorageAccess";
import type { LogFunction } from "@lib/services/lib/logUtils";
import type { ServiceHub } from "@lib/services/ServiceHub";
import type { IServiceHub } from "@lib/services/base/IService";

export interface ServiceModules {
    storageAccess: StorageAccess;
    /**
     * Database File Accessor for handling file operations related to the database, such as exporting the database, importing from a file, etc.
     */
    databaseFileAccess: DatabaseFileAccess;

    /**
     * File Handler for handling file operations related to replication, such as resolving conflicts, applying changes from replication, etc.
     */
    fileHandler: IFileHandler;
    /**
     * Rebuilder for handling database rebuilding operations.
     */
    rebuilder: Rebuilder;
}
/**
 * Selects service dependencies from the host's service type.
 * A context is retained when the selected source exposes one. The default
 * source preserves the existing ServiceHub dependency contract.
 */
export type RequiredServices<T extends keyof THub, THub = ServiceHub> = Pick<THub, T | Extract<"context", keyof THub>>;
export type RequiredServiceModules<T extends keyof ServiceModules> = Pick<ServiceModules, T>;

export type RequiredServicesInterfaces<T extends keyof IServiceHub> = RequiredServices<T, IServiceHub>;
export type RequiredServiceModulesInterfaces<T extends keyof ServiceModules> = Pick<ServiceModules, T>;

/**
 * Declares the Services and ServiceModules consumed by a feature.
 * Select a more specific source to retain injectable handlers or an extended
 * host context, or use IServiceHub for operation-only interfaces. Additional
 * collaborators, such as a borrowed LogFunction, belong in the feature's own
 * dependency type. This type neither selects runtime values nor owns them.
 */
export type NecessaryServices<T extends keyof THub, U extends keyof ServiceModules, THub = ServiceHub> = {
    services: RequiredServices<T, THub>;
    serviceModules: RequiredServiceModules<U>;
};

export type NecessaryServicesInterfaces<
    T extends keyof IServiceHub,
    U extends keyof ServiceModules,
> = NecessaryServices<T, U, IServiceHub>;

export type ServiceFeatureFunction<T extends keyof THub, U extends keyof ServiceModules, TR, THub = ServiceHub> = (
    host: NecessaryServices<T, U, THub>
) => TR;
type ServiceFeatureContext<T> = T & {
    _log: LogFunction;
};
export type ServiceFeatureFunctionWithContext<
    T extends keyof THub,
    U extends keyof ServiceModules,
    C,
    TR,
    THub = ServiceHub,
> = (host: NecessaryServices<T, U, THub>, context: ServiceFeatureContext<C>) => TR;

type AnyServiceFeature = (...args: never[]) => unknown;
type ServiceFeatureWithArguments<T extends keyof THub, U extends keyof ServiceModules, THub = ServiceHub> = (
    host: NecessaryServices<T, U, THub>,
    ...args: never[]
) => unknown;

/**
 * Retains a service feature's complete function type and identity.
 * Declare the dependency type on the feature parameter so that required
 * collaborators, concrete service types, and returned views remain explicit.
 * Optional arguments, overloads, generic signatures, and asynchronous results
 * are preserved. Older unannotated callbacks retain their ServiceHub context;
 * their dependency keys cannot be inferred from the callback body.
 *
 * This helper does not invoke the feature, acquire or release its dependencies,
 * or wrap its return value or errors. The host owns composition and disposal.
 * @param featureFunction The feature function to retain.
 * @returns The supplied function without a runtime wrapper.
 * @example
 * type IndexHost = NecessaryServices<"appLifecycle", "storageAccess">;
 * const useIndexFeature = createServiceFeature((host: IndexHost) => {
 *   const { appLifecycle } = host.services;
 *   const { storageAccess } = host.serviceModules;
 *
 *   appLifecycle.onLoaded.addHandler(async () => {
 *     await storageAccess.getFileNames();
 *     return true;
 *   });
 * });
 */
export function createServiceFeature<
    TFeature extends ServiceFeatureWithArguments<keyof ServiceHub, keyof ServiceModules>,
>(featureFunction: TFeature): TFeature;
export function createServiceFeature<TFeature extends AnyServiceFeature>(featureFunction: TFeature): TFeature;
export function createServiceFeature<T extends keyof ServiceHub, U extends keyof ServiceModules, TR>(
    featureFunction: ServiceFeatureFunction<T, U, TR>
): ServiceFeatureFunction<T, U, TR>;
export function createServiceFeature(featureFunction: AnyServiceFeature): AnyServiceFeature {
    return featureFunction;
}

type ContextFactory<T extends keyof THub, U extends keyof ServiceModules, C, THub = ServiceHub> = (
    host: NecessaryServices<T, U, THub>
) => ServiceFeatureContext<C>;

/** Selects the host type for the existing service-feature builder. */
export function serviceFeature<T extends keyof THub, U extends keyof ServiceModules, THub = ServiceHub>() {
    function create<
        TR,
        TFeature extends (host: NecessaryServices<T, U, THub>, ...args: never[]) => TR = ServiceFeatureFunction<
            T,
            U,
            TR,
            THub
        >,
    >(featureFunction: TFeature): TFeature {
        return featureFunction;
    }

    return {
        create,
        withContext<C extends object = object>(ContextFactory: ContextFactory<T, U, C, THub>) {
            return {
                create:
                    <TR>(featureFunction: ServiceFeatureFunctionWithContext<T, U, C, TR, THub>) =>
                    (host: NecessaryServices<T, U, THub>, context: ServiceFeatureContext<C>) =>
                        featureFunction(host, ContextFactory(host)),
            };
        },
    };
}
