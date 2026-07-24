/**
 * Settings defaults and migration contracts shared by maintained hosts.
 *
 * @packageDocumentation
 */

export {
    DEFAULT_SETTINGS,
    NEW_VAULT_SETTINGS,
    P2P_DEFAULT_SETTINGS,
    SETTINGS_SCHEMA_DEFAULTS,
    createNewVaultSettings,
} from "./common/models/setting.const.defaults.ts";
export {
    PREFERRED_BASE,
    PREFERRED_JOURNAL_SYNC,
    PREFERRED_SETTING_CLOUDANT,
    PREFERRED_SETTING_SELF_HOSTED,
} from "./common/models/setting.const.preferred.ts";
export { CURRENT_SETTING_VERSION } from "./common/models/setting.const.ts";
export {
    prepareSettingsForLoad,
    SettingsMigrationReviewCodes,
    type PreparedSettings,
    type SettingsMigrationReviewCode,
    type SettingsMigrationReviewReason,
    type SettingsMigrationState,
} from "./common/models/setting.lifecycle.ts";
export type {
    ObsidianLiveSyncSettings,
    RemoteDBSettings,
    RemoteTypeSettings,
} from "./common/models/setting.type.ts";
