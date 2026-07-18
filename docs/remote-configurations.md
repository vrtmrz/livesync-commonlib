# Remote configuration profiles

Commonlib represents saved remote connections as independently named profiles. The profile map is the persisted source for multiple-remote selection. Existing CouchDB, Object Storage, and P2P fields remain the runtime projection consumed by compatibility services.

Use the focused entry point for new profile-management code:

```ts
import {
    upsertRemoteConfigurationInPlace,
    type RemoteConfiguration,
} from "@vrtmrz/livesync-commonlib/remote-configurations";
import { createNewVaultSettings } from "@vrtmrz/livesync-commonlib/settings";

const settings = createNewVaultSettings();
Object.assign(settings, {
    couchDB_URI: "https://couch.example",
    couchDB_USER: "alice",
    couchDB_PASSWORD: "secret",
    couchDB_DBNAME: "notes",
});

const profile: RemoteConfiguration = upsertRemoteConfigurationInPlace(settings, "couchdb", {
    activate: true,
});
```

The helper serialises the connection fields into the profile URI. When `activate` is true, it selects that profile through `activeConfigurationId` and projects the profile back onto the compatibility fields. The host still owns persistence, restart policy, credential acquisition, and user confirmation.

## Identity and display names

Profile IDs are opaque identity. Omit `id` to allocate a new one and preserve every existing profile. Pass a known `id` only when deliberately updating that profile.

Display names are presentation, not identity. When `name` is omitted, Commonlib proposes a concise type-specific name such as `CouchDB couch.example`, `S3 notes`, or `P2P team-room`. It adds a numeric suffix when that display name is already present. A host may let users rename profiles without changing their IDs or selections.

There is no special profile named or identified as `default`. The selected main remote is represented only by `activeConfigurationId`.

## Main and P2P selections

`activeConfigurationId` selects the main remote used by ordinary replication. `P2P_ActiveRemoteConfigurationId` independently selects the profile used by P2P features.

- Use `{ activate: true }` for a CouchDB or Object Storage profile selected as the main remote.
- Use `{ activate: true, activateForP2P: true }` when P2P is the main remote.
- Use `{ activateForP2P: true }` to select a P2P profile without changing the main remote.

Selecting a profile updates the compatibility fields immediately. Existing replication services may therefore continue to consume those fields while profile-aware hosts treat the profile map and selection IDs as authoritative persisted state.

## Import and migration boundary

A modern Setup URI or another settings transport should preserve `remoteConfigurations`, profile IDs, display names, `activeConfigurationId`, and `P2P_ActiveRemoteConfigurationId` exactly.

An older settings payload may contain only the flat remote fields. The standard `SettingService` recognises that shape when the profile map is empty and migrates the configured connections into explicitly labelled `legacy-*` profiles. This is a compatibility path, not the recommended way to create a new profile. New setup flows should call the focused API directly.

If a settings payload already contains profiles, legacy migration does not create or replace any entry. A host which writes only flat fields in that state would therefore fail to register a new connection; profile-aware setup code must upsert the profile explicitly.

## Persistence and encryption

The helper stores a plaintext connection URI in memory and marks the changed profile as unencrypted. The standard `SettingService` applies configured at-rest encryption when persisting settings. A host using a different persistence service must provide equivalent encryption and decryption policy itself.

## Verification ownership

Commonlib unit tests cover preserving existing profiles, generated-name collision handling, main-remote activation, and independent P2P selection. The packed-package test imports the focused entry from a clean consumer and checks its declarations and runtime exports.

Hosts remain responsible for testing their dialogues, import classification, confirmation, Fetch or Rebuild scheduling, persistence, restart ordering, and real-runtime presentation.
