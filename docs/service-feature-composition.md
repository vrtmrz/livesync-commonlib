---
date: 2026-10-25
commonlib-version: "0.2.0"
self-hosted-livesync-version: "1.0.40"
status: published
---

# Service feature composition

Publication update, 2nd November, 2026: the Service Hub source selection, narrowed
host dependencies, and signature-preserving composition helpers are published
in Commonlib [0.2.3](https://github.com/vrtmrz/livesync-commonlib/releases/tag/0.2.3)
and used by Self-hosted LiveSync 1.0.44. The front matter retains the original
review date and version baseline.

This guide is for Commonlib and maintained-host developers who are adding behaviour to the Service Hub composition. It explains when to extend a Service, create a serviceFeature, share a ServiceModule, or introduce a class which owns a resource.

The choice is primarily about dependency direction and ownership. Mutable state alone does not require a class or a ServiceModule.

## Choose the narrowest composition form

| Need                                                                              | Preferred form                                                        | Reason                                                                                          |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Add one check, notification, or transformation to an existing contract            | Register a handler on the owning Service                              | The Service already defines the ordering, result, and lifetime.                                 |
| Connect several Services or ServiceModules to one feature                         | serviceFeature                                                        | Dependencies remain explicit, and host-specific composition stays outside the domain operation. |
| Retain state used only by one composed feature                                    | Private context created by a serviceFeature                           | State remains bounded without becoming a shared service locator.                                |
| Share one long-lived operational capability between several consumers             | ServiceModule                                                         | The host constructs one typed capability and makes its lifetime explicit.                       |
| Own an external resource with identity, replacement, abort, or disposal semantics | Focused class or resource owner, usually composed by a serviceFeature | The object lifetime is part of the contract rather than an implementation convenience.          |
| Integrate with an existing legacy application Module                              | Keep the existing Module at that boundary                             | Preserve the established integration, but do not widen it into a new general pattern.           |

## Declare dependencies at the boundary

Use `NecessaryServices` to state the exact Services and ServiceModules which a feature consumes. Its type parameters select service keys, module keys, and the Service Hub source; the source defaults to `ServiceHub`. The selected Services retain `context` when that source exposes it. The `NecessaryServicesInterfaces` alias continues to use `IServiceHub` without adding an implicit context to that interface contract.

```typescript
type IndexFeatureHost = NecessaryServices<"appLifecycle" | "API", "storageAccess">;

export const useIndexFeature = createServiceFeature((host: IndexFeatureHost) => {
    const { appLifecycle, API } = host.services;
    const { storageAccess } = host.serviceModules;

    appLifecycle.onLoaded.addHandler(async () => {
        const paths = await storageAccess.getFileNames();
        API.addLog(`Indexed ${paths.length} paths`);
        return true;
    });
});
```

Select a more specific host when a feature needs an injectable handler type or host-extended context. Collaborators outside the Service Hub and ServiceModules, such as a borrowed logger, belong in the feature's own dependency type:

```typescript
type FeatureHost = NecessaryServices<
    "appLifecycle" | "conflict",
    never,
    InjectableServiceHub
> & {
    readonly log: LogFunction;
};
```

`createServiceFeature()` returns the supplied function unchanged. Its declared host type, optional or additional arguments, generic or overloaded signature, and result type, including a `Promise` or focused view, remain available to callers. Dependency keys are not inferred from the callback body. An unannotated legacy callback retains the full default `ServiceHub` contract for compatibility, so annotate the host parameter when a narrow contract is intended. Existing `createServiceFeature<T, U, Result>(...)` calls remain supported. The `serviceFeature<T, U, THub>().create(...)` builder also selects a source and preserves the supplied function type. Its existing `.create<Result>(...)` call shape and `withContext()` behaviour are unchanged.

This signature is both documentation and a compile-time boundary. Adding an unrelated Service to the host object does not make it available to the feature. If the operation needs another collaborator, add it deliberately to the declared contract.

A serviceFeature is a composition function, not a runtime registry entry. Call it from the host composition after its dependencies exist:

```typescript
useIndexFeature({
    services: {
        context: serviceHub.context,
        appLifecycle: serviceHub.appLifecycle,
        API: serviceHub.API,
    },
    serviceModules: { storageAccess },
});
```

Do not bind a serviceFeature to an application object merely to obtain `this`. Pass the narrow host value directly.

## Separate an operation from its composition

When an operation has meaningful sequencing or failure behaviour, keep it independently callable and let the serviceFeature own only construction and registration.

`prepareDatabaseForUse.ts` follows this split. Its operation accepts explicit collaborators and returns the application result:

```typescript
type PrepareDatabaseOperationHost = NecessaryServices<
    "appLifecycle" | "vault" | "database" | "databaseEvents" | "fileProcessing" | "replicator",
    never
>;
type PrepareDatabaseFeatureHost = NecessaryServices<
    "API" | "appLifecycle" | "vault" | "database" | "databaseEvents" | "fileProcessing" | "replicator",
    never
>;

export async function prepareDatabaseForUse(
    host: PrepareDatabaseOperationHost,
    log: LogFunction,
    errorManager: UnresolvedErrorManager,
    showingNotice = false,
    reopenDatabase = true,
    ignoreSuspending = false,
    continueOnFileFailure = false
): Promise<VaultScanResult> {
    // Open, scan, run completion handlers, commit pending events, and mark ready.
}
```

The operation does not need `setting` or `path`. The corresponding composition adds `API` to create the instance logger, constructs the owned error manager, and registers one adapter function:

```typescript
export function usePrepareDatabaseForUse(host: PrepareDatabaseFeatureHost): void {
    const log = createInstanceLogFunction("SF:prepareDatabaseForUse", host.services.API);
    const errorManager = new UnresolvedErrorManager(host.services.appLifecycle, host.services.context.events);

    host.services.databaseEvents.initialiseDatabase.addHandler(
        (showingNotice = false, reopenDatabase = true, ignoreSuspending = false, continueOnFileFailure = false) =>
            prepareDatabaseForUse(
                host,
                log,
                errorManager,
                showingNotice,
                reopenDatabase,
                ignoreSuspending,
                continueOnFileFailure
            )
    );
}
```

Test the operation's sequencing and failure short-circuiting separately from the handler registration. This keeps a lifecycle rename from forcing every domain test through an application-shaped fixture.

The offline scanner follows the same split. A full-scan operation uses only the file and database dependencies, while the composer adds `API` for its logger and `appLifecycle` for its error manager and handler registration:

```typescript
type FullScanHost = NecessaryServices<
    "setting" | "vault" | "path" | "database" | "keyValueDB",
    "storageAccess" | "fileHandler"
>;

type OfflineScannerFeatureHost = NecessaryServices<
    "API" | "appLifecycle" | "setting" | "vault" | "path" | "database" | "keyValueDB",
    "storageAccess" | "fileHandler"
>;
```

`performFullScan` uses the full-scan host, and its scan operations declare their own narrower service sets; none requires `fileProcessing`. `useOfflineScanner` binds the `vault.scanVault` handler with the composer host. The scanner does not require `databaseEvents` or `replicator`.

### Separate remote-configuration operation and composition hosts

`RemoteConfigHost` remains the broad exported compatibility type for existing callers. The implementation uses private host types so each operation or composer declares only its required Services:

| Implementation boundary | Private host type | Required Services |
| --- | --- | --- |
| Remote configuration migration operation | `RemoteConfigMigrationHost` | `setting`, `API` |
| Migration feature composer | `RemoteConfigMigrationFeatureHost` | `setting`, `API`, `appLifecycle` |
| Switch-connection command | `RemoteConfigSwitchHost` | `setting`, `UI`, `control`, `API` |
| Replication command and feature composer | `RemoteConfigReplicationHost` | `setting`, `UI`, `replication`, `control`, `API` |

Keep the broad export for compatibility and use the focused private types inside the implementation.

Database preparation and full scanning remain strict by default. A host may set `continueOnFileFailure` only when its ordinary start-up policy deliberately permits readiness after individual file-pair failures. In that case, the operation returns `completed-with-file-failures` after all later initialisation steps succeed; it does not collapse the result into `true`. That option does not admit a failed scan precondition or a later initialisation step, and explicit recovery workflows retain the default.

The `scanVault` and `initialiseDatabase` services use a failure-veto result aggregator for this contract. It preserves the first non-boolean continuation result but still invokes later handlers, so a later `false` result or exception rejects the operation. `firstResult` is not suitable here because it would return the partial result before those handlers can veto it.

## Keep feature-local state private

State which exists for one predicate, cache, queue, or scheduling policy can remain in a factory or private context. It does not need to become a property on the application core.

`targetFilter.ts` uses one factory per stateful predicate. The ignore-file factory owns its settings snapshot and cache:

```typescript
type IgnoreFileHost = NecessaryServices<"setting" | "appLifecycle", "storageAccess">;

export function isAcceptedByIgnoreFilesFactory(host: IgnoreFileHost, log: LogFunction) {
    let ignoreFiles: string[] = [];
    const ignoreFileCacheMap = new Map<string, string[] | undefined | false>();

    const refreshSettings = () => {
        ignoreFiles = host.services.setting
            .currentSettings()
            .ignoreFiles.split(",")
            .map((value) => value.trim());
        return Promise.resolve(true);
    };

    host.services.setting.onSettingRealised.addHandler(refreshSettings);
    return async function isAcceptedByIgnoreFiles(file: string | UXFileInfoStub): Promise<boolean> {
        // Evaluate the current path with the private cache.
    };
}
```

`useTargetFilters` then creates the predicates and registers their public effects in the required order. The cache is not exposed merely so that composition code can reach it.

Use one private context when several functions share the same state:

```typescript
type DeferredTaskHost = NecessaryServices<"appLifecycle", never>;

interface DeferredTaskContext {
    pending: Set<Promise<unknown>>;
    stopped: boolean;
}

interface DeferredTaskControl {
    track(task: Promise<unknown>): void;
}

function trackTask(context: DeferredTaskContext, task: Promise<unknown>): void {
    if (!context.stopped) context.pending.add(task);
}

function stopTasks(context: DeferredTaskContext): void {
    context.stopped = true;
    context.pending.clear();
}

export function useDeferredTasks(host: DeferredTaskHost): DeferredTaskControl {
    const context: DeferredTaskContext = { pending: new Set(), stopped: false };
    host.services.appLifecycle.onUnload.addHandler(() => {
        stopTasks(context);
        return Promise.resolve(true);
    });
    return { track: (task) => trackTask(context, task) };
}
```

Return only the focused view which another consumer needs. Do not return the private context or add it to the complete Service Hub.

## Use a ServiceModule for a shared operational capability

A ServiceModule is appropriate when several consumers must use the same long-lived capability or resource owner. Current examples include `storageAccess`, `databaseFileAccess`, `fileHandler`, and `rebuilder`.

Before adding one, verify all of the following:

- more than one consumer needs the same identity or lifetime;
- its public operations form a coherent capability;
- construction and disposal belong to the host composition;
- its dependencies can be declared without accepting the complete application core; and
- a private serviceFeature context would not provide the same behaviour more simply.

Do not promote a value to `ServiceModules` merely because a test needs to reach it. Inject the focused view into the current consumer instead.

## Use a class only when identity or lifetime is part of the contract

A class is justified when behaviour depends on stable identity, replaceable implementations, serialised ownership, or an explicit resource lifecycle such as `abort()`, `close()`, or `dispose()`.

The P2P composition is an example at a larger scale: room-session and transport owners have identities, concurrent operations must be fenced, and shutdown order matters. Their classes own those invariants. The surrounding serviceFeature connects them to Services and gives each consumer only a focused view.

A class is usually unnecessary when it would only:

- store collaborators which can be function parameters;
- group private helper functions;
- provide a convenient `this` value;
- mirror the Service Hub; or
- expose state solely for tests.

## Test interactions at the composition boundary

Use London School tests for a serviceFeature. Verify its observable collaboration rather than reconstructing the complete application:

```typescript
it("registers the database preparation operation", async () => {
    let handler: (() => Promise<boolean>) | undefined;
    const addHandler = vi.fn((value) => {
        handler = value;
    });
    const prepare = vi.fn(async () => true);

    useExampleDatabaseFeature(makeHost({ addHandler, prepare }));

    expect(addHandler).toHaveBeenCalledOnce();
    await expect(handler?.()).resolves.toBe(true);
    expect(prepare).toHaveBeenCalledOnce();
});
```

For a state owner, test transitions and invariants directly. For an operation, verify collaborator order, the first rejected result, and which later effects do not run.

Stop and review the design when a focused test requires:

- a complete application-core fixture;
- a deep chain of mocks;
- import-order substitution or process-global mutation;
- unrelated Services merely to construct the subject; or
- access to private state instead of an observable result.

This friction is a design-review signal. It is not a reason to publish more internals or add a broader test helper.

## Working with legacy Modules

Existing hosts may still use `AbstractModule` or an equivalent legacy layer. Retain that boundary when its identity, registration, or host integration is part of the current change. New Commonlib composition must not require a host to provide its complete application core.

When modifying an existing Module:

1. identify the operation or state owner which can have a narrow contract;
2. move that bounded part only when the current behaviour needs it;
3. keep host-specific UI and registration at the application boundary;
4. add interaction tests around the extracted boundary; and
5. avoid an unrelated mechanical conversion of neighbouring Modules.

The maintained Self-hosted LiveSync guidance documents the additional risks of its `AbstractModule` and `AbstractObsidianModule` implementations.

## Review checklist

Before accepting a new composition, confirm that:

- the owner of each mutable state and external resource is clear;
- dependencies appear in the function or constructor signature;
- the feature receives no broader host object than it uses;
- handler ordering and failure results belong to the owning Service contract;
- returned values are focused consumer views rather than service locators;
- disposal and replacement are explicit when resources outlive one call; and
- focused interaction tests can be written without a broad fixture.
