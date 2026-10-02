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
    deriveIdKey,
    deriveOrImportIdKey,
    formatIdRecoveryCode,
    configuredIdKey,
    ID_DERIVATION_VERSION,
    ID_RECOVERY_CODE_PREFIX,
} from "./common/idDerivation.ts";
export {
    prepareSettingsForLoad,
    SettingsMigrationReviewCodes,
    type PreparedSettings,
    type SettingsMigrationReviewCode,
    type SettingsMigrationReviewReason,
    type SettingsMigrationState,
} from "./common/models/setting.lifecycle.ts";
export { assessTweakCompatibility } from "./common/models/tweak.compatibility.ts";
export type {
    TweakAssessment,
    TweakAssessmentEntry,
    TweakAssessmentRelation,
    TweakAssessmentValue,
    TweakTransition,
    TweakTransitionReason,
} from "./common/models/tweak.compatibility.ts";
export type { TweakReconstruction, TweakValues } from "./common/models/tweak.definition.ts";
export type { ObsidianLiveSyncSettings, RemoteDBSettings, RemoteTypeSettings } from "./common/models/setting.type.ts";
export {
    SETTINGS_PROPERTY_POLICY,
    SettingPolicies,
    createMarkdownSettings,
    mergeMarkdownSettings,
    type SettingPropertyPolicy,
    type MarkdownSettings,
    type CredentialFreeMarkdownSettings,
    type PersistedSettings,
} from "./common/models/setting.policy.ts";
