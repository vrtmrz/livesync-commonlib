import {
    SETTINGS_PROPERTY_POLICY,
    SettingPolicies,
    createMarkdownSettings,
    type CredentialFreeMarkdownSettings,
    type MarkdownSettings,
    type ObsidianLiveSyncSettings,
    type PersistedSettings,
    type SettingPropertyPolicy,
} from "@vrtmrz/livesync-commonlib/settings";
import type { ServiceContext } from "@vrtmrz/livesync-commonlib/context";
import type { InjectableSettingService } from "@vrtmrz/livesync-commonlib/compat/services/implements/injectable/InjectableSettingService";

const defaultPolicy: SettingPropertyPolicy = SettingPolicies.Default;
// @ts-expect-error Additional policy combinations require a definition.
const unsupportedPolicy = { markdown: "omit", persistence: "connection" } satisfies SettingPropertyPolicy;
void defaultPolicy;
void unsupportedPolicy;

type ExtendedSettings = ObsidianLiveSyncSettings & { nextCredential: string };
type OptionalExtension = ObsidianLiveSyncSettings & { nextCredential?: string };

// @ts-expect-error Every new setting requires an explicit policy.
SETTINGS_PROPERTY_POLICY satisfies Record<keyof ExtendedSettings, SettingPropertyPolicy>;
// @ts-expect-error Optional schema properties also require an explicit policy.
SETTINGS_PROPERTY_POLICY satisfies Record<keyof OptionalExtension, SettingPropertyPolicy>;
const { secretKey, ...withoutSecretKey } = SETTINGS_PROPERTY_POLICY;
// @ts-expect-error The policy table lists every declared setting.
withoutSecretKey satisfies Record<keyof ObsidianLiveSyncSettings, SettingPropertyPolicy>;

declare const settings: ObsidianLiveSyncSettings;
declare const persisted: PersistedSettings;
declare const service: InjectableSettingService<ServiceContext>;
declare function persist(value: PersistedSettings): void;
declare function writeMarkdown(value: MarkdownSettings): void;
declare function writeWithoutCredentials(value: CredentialFreeMarkdownSettings): void;

// @ts-expect-error Persistence accepts prepared settings.
persist(settings);
// @ts-expect-error The maintained host persistence binder requires the prepared type.
service.saveData(settings);
// @ts-expect-error Prepared connection properties use their persisted representation.
persisted.accessKey = "synthetic-access-key";
// @ts-expect-error Connection payload values require preparation.
persisted.encryptedCouchDBConnection = "synthetic-plaintext";
// @ts-expect-error The Markdown writer accepts prepared settings.
writeMarkdown(settings);
// @ts-expect-error The selected Markdown output matches the sharing option.
writeWithoutCredentials(createMarkdownSettings(settings, true));

persist(persisted);
service.saveData(persisted);
writeMarkdown(createMarkdownSettings(settings));
writeWithoutCredentials(createMarkdownSettings(settings, false));
const runtimeKey: string = settings.accessKey;
void runtimeKey;
void secretKey;
