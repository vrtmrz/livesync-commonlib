import type { ObsidianLiveSyncSettings } from "../models/setting.type";
import { DEFAULT_SETTINGS } from "../models/setting.const.defaults";
import { configurationNames, type ConfigLevel, type ConfigurationItem } from "../models/shared.definition.configNames";

export type SettingStorageDomain = "persisted" | "local" | "derived" | "ephemeral";

export type SettingValueKind = "boolean" | "text" | "password" | "number" | "select" | "textarea" | "custom";

export type SettingCapability =
    | "database-user"
    | "server-admin"
    | "filesystem"
    | "obsidian-shell"
    | "obsidian-plugin-host";

export type SettingEffect =
    | "requires-local-rebuild"
    | "requires-remote-rebuild"
    | "requires-restart"
    | "requires-apply-settings"
    | "suspends-sync"
    | "updates-unresolved-error-ui"
    | "changes-active-remote"
    | "reopens-local-database"
    | "expands-preset";

export type SettingValidationResult = {
    ok: boolean;
    message?: string;
};

export type SettingCommitPolicy<TKey extends string = string> = {
    mode: "immediate" | "explicit";
    group?: string;
    applyKeys?: TKey[];
};

export type ExplicitSettingCommitGroup<TKey extends string = string> = {
    group: string;
    keys: TKey[];
    applyKeys: TKey[];
};

export type SettingEvaluationContext<TSettings extends object = Record<string, unknown>> = {
    editingSettings: TSettings;
    persistedSettings?: Partial<TSettings>;
    capabilities?: Partial<Record<SettingCapability, boolean>>;
};

export type SettingDefinition<TKey extends string = string> = {
    key: TKey;
    storage: SettingStorageDomain;
    kind: SettingValueKind;
    defaultValue?: unknown;
    labelKey: string;
    descriptionKey?: string;
    label: string;
    description?: string;
    level?: ConfigLevel;
    status?: ConfigurationItem["status"];
    obsolete?: boolean;
    internal?: boolean;
    placeholder?: string;
    secret?: boolean;
    requiredCapabilities?: SettingCapability[];
    affects?: SettingEffect[];
    commit?: SettingCommitPolicy<TKey>;
    render: "auto" | "custom";
};

export type SettingDefinitionMetadata = ConfigurationItem & {
    kind?: SettingValueKind;
    storage?: SettingStorageDomain;
    internal?: boolean;
    requiredCapabilities?: SettingCapability[];
    affects?: SettingEffect[];
    commit?: SettingCommitPolicy<keyof ObsidianLiveSyncSettings & string> | SettingCommitPolicy<string>;
    render?: "auto" | "custom";
};

function inferSettingValueKind(defaultValue: unknown, metadata?: SettingDefinitionMetadata): SettingValueKind {
    if (metadata?.kind) {
        return metadata.kind;
    }
    if (metadata?.isHidden) {
        return "password";
    }
    if (typeof defaultValue === "boolean") {
        return "boolean";
    }
    if (typeof defaultValue === "number") {
        return "number";
    }
    return "text";
}

function inferInternal(metadata?: SettingDefinitionMetadata): boolean {
    if (metadata?.internal !== undefined) {
        return metadata.internal;
    }
    return metadata?.obsolete === true;
}

export function createSettingDefinitions<TDefaults extends object>(
    defaults: TDefaults,
    metadata: Partial<Record<keyof TDefaults | string, SettingDefinitionMetadata>>,
    resolveStorage: (key: keyof TDefaults & string) => SettingStorageDomain = () => "persisted"
): SettingDefinition<keyof TDefaults & string>[] {
    const defaultsRecord = defaults as Record<string, unknown>;
    return (Object.keys(defaults) as (keyof TDefaults & string)[]).map((key) => {
        const item = metadata[key];
        const defaultValue = defaultsRecord[key];
        const labelKey = item?.name ?? key;
        const descriptionKey = item?.desc;
        return {
            key,
            storage: item?.storage ?? resolveStorage(key),
            kind: inferSettingValueKind(defaultValue, item),
            defaultValue,
            labelKey,
            descriptionKey,
            label: labelKey,
            description: descriptionKey,
            level: item?.level,
            status: item?.status,
            obsolete: item?.obsolete,
            internal: inferInternal(item),
            placeholder: item?.placeHolder,
            secret: item?.isHidden,
            requiredCapabilities: item?.requiredCapabilities,
            affects: item?.affects,
            commit: item?.commit as SettingCommitPolicy<keyof TDefaults & string> | undefined,
            render: item?.render ?? "auto",
        };
    });
}

export function getSettingDefinitionFrom<TKey extends string>(
    definitions: readonly SettingDefinition<TKey>[],
    key: TKey
): SettingDefinition<TKey> | undefined {
    return definitions.find((definition) => definition.key === key);
}

export function listExplicitSettingCommitGroups<TKey extends string>(
    definitions: readonly SettingDefinition<TKey>[]
): ExplicitSettingCommitGroup<TKey>[] {
    const groups = new Map<string, { keys: Set<TKey>; applyKeys: Set<TKey> }>();
    for (const definition of definitions) {
        const commit = definition.commit;
        if (commit?.mode !== "explicit" || !commit.group) {
            continue;
        }
        const group = groups.get(commit.group) ?? { keys: new Set<TKey>(), applyKeys: new Set<TKey>() };
        group.keys.add(definition.key);
        for (const applyKey of commit.applyKeys ?? [definition.key]) {
            group.applyKeys.add(applyKey as TKey);
        }
        groups.set(commit.group, group);
    }
    return [...groups.entries()].map(([group, keys]) => ({
        group,
        keys: [...keys.keys],
        applyKeys: [...keys.applyKeys],
    }));
}

export function getExplicitSettingCommitGroup<TKey extends string>(
    definitions: readonly SettingDefinition<TKey>[],
    group: string
): ExplicitSettingCommitGroup<TKey> | undefined {
    return listExplicitSettingCommitGroups(definitions).find((commitGroup) => commitGroup.group === group);
}

export const persistedSettingDefinitions = createSettingDefinitions(DEFAULT_SETTINGS, configurationNames);

export function getPersistedSettingDefinition(
    key: keyof ObsidianLiveSyncSettings
): SettingDefinition<keyof ObsidianLiveSyncSettings & string> | undefined {
    return getSettingDefinitionFrom(persistedSettingDefinitions, key as keyof ObsidianLiveSyncSettings & string);
}
