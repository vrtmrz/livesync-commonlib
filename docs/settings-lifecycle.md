# Settings lifecycle

Commonlib separates three values which older integrations commonly treated as one object:

- `SETTINGS_SCHEMA_DEFAULTS` completes keys which are absent from stored settings. Its values remain conservative so that an upgrade does not silently change an existing choice.
- `NEW_VAULT_SETTINGS` initialises a store which has never contained Self-hosted LiveSync settings. It includes the current recommended base values.
- the `PREFERRED_SETTING_*` objects add remote-specific recommendations when a user explicitly selects Cloudant, self-hosted CouchDB, or Object Storage during setup.

`DEFAULT_SETTINGS` remains an alias of `SETTINGS_SCHEMA_DEFAULTS` for compatibility. New code should choose the named contract which matches its operation.

## Starting a new Vault

Use `createNewVaultSettings()` only when the settings store is absent or empty, or when the user explicitly requests a factory reset. `NEW_VAULT_SETTINGS` exposes the values for inspection, while the factory prevents mutable nested settings from being shared between clients:

```ts
import { createNewVaultSettings } from "@vrtmrz/livesync-commonlib/settings";

const initialSettings = createNewVaultSettings();
```

The recommended base currently selects a 50 MB maximum synchronised file size, Rabin–Karp chunk splitting, fixed chunk revisions, Plug-in Sync V2, case-insensitive file-name handling, and E2EE V2. It does not enable synchronisation or encryption on behalf of the user.

Apply a remote-specific preferred object only while configuring that remote. Do not merge it into an existing stored configuration merely because the remote type can be inferred.

## Loading existing settings

`prepareSettingsForLoad` detects a blank store, completes stored settings with conservative schema fallbacks, runs ordered schema migrations, and reports the result separately from the settings value:

```ts
import { prepareSettingsForLoad } from "@vrtmrz/livesync-commonlib/settings";

const prepared = prepareSettingsForLoad(await host.loadSettings());
const settings = prepared.settings;

if (prepared.changed && !prepared.isFromFutureSchema) {
    await host.saveSettings(settings);
}

if (prepared.requiresSyncReview) {
    host.requestLocalSyncReview(prepared.reviewReasons);
}
```

Explicit stored values take precedence over every fallback. A migration therefore preserves synchronisation switches and other user choices unless a migration step documents a deliberate transformation.

The standard Commonlib `SettingService` performs this preparation automatically. Hosts which use that service can inspect `getSettingsMigrationState()` after `loadSettings()` instead of calling the function themselves.

## Review and downgrade boundary

A migration may report `requiresSyncReview` when automatic synchronisation should wait for a human decision. Commonlib reports that requirement but does not disable synchronisation settings, persist an acknowledgement, display a dialogue, or decide whether replication may proceed. Those are host-local responsibilities because one device must not acknowledge a safety review for another device through synchronised settings.

Settings written by a schema newer than the running Commonlib version are completed for in-memory compatibility but are not assigned an older schema version. The result has `isFromFutureSchema: true`, `changed: false`, and a review reason. A host must not persist that completed object as a downgrade migration.

The settings schema version is independent of the package version and of any remote data or protocol compatibility version. Increment it only when the stored settings shape requires an ordered migration.

## Tests owned by Commonlib

The settings lifecycle unit tests cover blank stores, representative legacy choices, migration idempotence, legacy review state, future-schema downgrade protection, and the distinction between new-Vault recommendations and stored-setting fallbacks. The packed-package test imports the focused `/settings` entry from a clean consumer and checks its declarations and runtime exports.

Hosts remain responsible for testing when setup is classified as new, how local review acknowledgement is stored, how replication is gated, and how their settings interface presents the result.
