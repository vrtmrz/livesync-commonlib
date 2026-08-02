import type { RemoteDBSettings, RemoteType } from "@lib/common/models/setting.type.ts";

export type RemoteProviderFamily = "couchdb" | "journal" | "p2p";
export type RemoteActivationRole = "main" | "p2p";

export interface RemoteProviderConfiguration {
    readonly settings: object;
    readonly type: string;
}

export interface RemoteProviderDescriptor<TType extends string, TSettings extends object> {
    readonly activationRoles: readonly RemoteActivationRole[];
    readonly family: RemoteProviderFamily;
    readonly legacyProfileId: string;
    readonly legacyProfileName: string;
    readonly remoteType: RemoteType;
    readonly schemes: readonly string[];
    readonly type: TType;
    hasConfiguration(settings: Partial<RemoteDBSettings>): boolean;
    parse(uri: string): TSettings;
    pick(settings: RemoteDBSettings): TSettings;
    serialise(settings: TSettings): string;
    suggestName(settings: TSettings): string;
}

interface RegisteredRemoteProviderDescriptor {
    readonly activationRoles: ReadonlySet<RemoteActivationRole>;
    readonly family: RemoteProviderFamily;
    readonly legacyProfileId: string;
    readonly legacyProfileName: string;
    readonly remoteType: RemoteType;
    readonly schemes: readonly string[];
    readonly type: string;
    configurationFromSettings(settings: RemoteDBSettings): RemoteProviderConfiguration;
    hasConfiguration(settings: Partial<RemoteDBSettings>): boolean;
    parse(uri: string): RemoteProviderConfiguration;
    serialise(configuration: RemoteProviderConfiguration): string;
    suggestName(configuration: RemoteProviderConfiguration): string;
}

function connectionScheme(uri: string): string {
    const match = /^sls\+([^:]+):/u.exec(uri);
    if (!match) throw new Error(`Unsupported URI: ${uri}`);
    return match[1].toLowerCase();
}

/**
 * Registry of the remote providers compiled into a host.
 *
 * Registration is deliberately explicit and becomes immutable before settings are loaded. This
 * keeps provider selection deterministic while allowing different hosts to compose different
 * maintained providers.
 */
export class RemoteProviderRegistry<TConfiguration extends RemoteProviderConfiguration = RemoteProviderConfiguration> {
    private readonly providersByRemoteType = new Map<RemoteType, RegisteredRemoteProviderDescriptor>();
    private readonly providersByScheme = new Map<string, RegisteredRemoteProviderDescriptor>();
    private readonly providersByType = new Map<string, RegisteredRemoteProviderDescriptor>();
    private frozen = false;

    constructor(descriptors: readonly RemoteProviderDescriptor<string, object>[] = []) {
        for (const descriptor of descriptors) this.register(descriptor);
    }

    register<TType extends string, TSettings extends object>(
        descriptor: RemoteProviderDescriptor<TType, TSettings>
    ): this {
        if (this.frozen) throw new Error("The remote provider registry is frozen");
        if (this.providersByType.has(descriptor.type)) {
            throw new Error(`Remote provider type '${descriptor.type}' is already registered`);
        }
        if (this.providersByRemoteType.has(descriptor.remoteType)) {
            throw new Error(`Remote type '${descriptor.remoteType}' is already registered`);
        }
        if (descriptor.schemes.length === 0) {
            throw new Error(`Remote provider '${descriptor.type}' must register at least one connection scheme`);
        }
        if (descriptor.activationRoles.length === 0) {
            throw new Error(`Remote provider '${descriptor.type}' must support at least one activation role`);
        }

        const schemes = descriptor.schemes.map((scheme) => scheme.toLowerCase());
        for (const scheme of schemes) {
            if (this.providersByScheme.has(scheme)) {
                throw new Error(`Remote connection scheme 'sls+${scheme}' is already registered`);
            }
        }

        const registered: RegisteredRemoteProviderDescriptor = {
            activationRoles: new Set(descriptor.activationRoles),
            family: descriptor.family,
            legacyProfileId: descriptor.legacyProfileId,
            legacyProfileName: descriptor.legacyProfileName,
            remoteType: descriptor.remoteType,
            schemes,
            type: descriptor.type,
            configurationFromSettings: (settings) => ({
                settings: descriptor.pick(settings),
                type: descriptor.type,
            }),
            hasConfiguration: (settings) => descriptor.hasConfiguration(settings),
            parse: (uri) => ({ settings: descriptor.parse(uri), type: descriptor.type }),
            serialise: (configuration) => descriptor.serialise(configuration.settings as TSettings),
            suggestName: (configuration) => descriptor.suggestName(configuration.settings as TSettings),
        };

        this.providersByType.set(registered.type, registered);
        this.providersByRemoteType.set(registered.remoteType, registered);
        for (const scheme of schemes) this.providersByScheme.set(scheme, registered);
        return this;
    }

    freeze(): this {
        this.frozen = true;
        return this;
    }

    isFrozen(): boolean {
        return this.frozen;
    }

    configurationsFromSettings(settings: RemoteDBSettings): TConfiguration[] {
        return this.providers().map((provider) => provider.configurationFromSettings(settings) as TConfiguration);
    }

    configurationFromSettings(type: TConfiguration["type"], settings: RemoteDBSettings): TConfiguration {
        return this.requireType(type).configurationFromSettings(settings) as TConfiguration;
    }

    parse(uri: string): TConfiguration {
        const scheme = connectionScheme(uri);
        const provider = this.providersByScheme.get(scheme);
        if (!provider) throw new Error(`Unsupported protocol: sls+${scheme}`);
        return provider.parse(uri) as TConfiguration;
    }

    serialise(configuration: TConfiguration): string {
        return this.requireType(configuration.type).serialise(configuration);
    }

    suggestName(configuration: TConfiguration): string {
        return this.requireType(configuration.type).suggestName(configuration);
    }

    applyConfiguration(
        settings: RemoteDBSettings,
        configuration: TConfiguration,
        activationRole: RemoteActivationRole = "main"
    ): RemoteDBSettings {
        const provider = this.requireType(configuration.type);
        if (!provider.activationRoles.has(activationRole)) {
            throw new Error(
                `Remote provider '${provider.type}' does not support the '${activationRole}' activation role`
            );
        }
        const currentRemoteType = settings.remoteType;
        Object.assign(settings, configuration.settings);
        settings.remoteType = activationRole === "main" ? provider.remoteType : currentRemoteType;
        return settings;
    }

    hasConfiguration(type: TConfiguration["type"], settings: Partial<RemoteDBSettings>): boolean {
        return this.requireType(type).hasConfiguration(settings);
    }

    typeForRemoteType(remoteType: RemoteType): TConfiguration["type"] | undefined {
        return this.providersByRemoteType.get(remoteType)?.type;
    }

    familyForRemoteType(remoteType: RemoteType): RemoteProviderFamily | undefined {
        return this.providersByRemoteType.get(remoteType)?.family;
    }

    isRemoteTypeInFamily(remoteType: RemoteType, family: RemoteProviderFamily): boolean {
        return this.familyForRemoteType(remoteType) === family;
    }

    supportsActivationRole(type: TConfiguration["type"], activationRole: RemoteActivationRole): boolean {
        return this.requireType(type).activationRoles.has(activationRole);
    }

    providerSummaries(): ReadonlyArray<{
        activationRoles: readonly RemoteActivationRole[];
        family: RemoteProviderFamily;
        legacyProfileId: string;
        legacyProfileName: string;
        remoteType: RemoteType;
        schemes: readonly string[];
        type: TConfiguration["type"];
    }> {
        return this.providers().map((provider) => ({
            activationRoles: [...provider.activationRoles],
            family: provider.family,
            legacyProfileId: provider.legacyProfileId,
            legacyProfileName: provider.legacyProfileName,
            remoteType: provider.remoteType,
            schemes: provider.schemes,
            type: provider.type,
        })) as ReadonlyArray<{
            activationRoles: readonly RemoteActivationRole[];
            family: RemoteProviderFamily;
            legacyProfileId: string;
            legacyProfileName: string;
            remoteType: RemoteType;
            schemes: readonly string[];
            type: TConfiguration["type"];
        }>;
    }

    private providers(): RegisteredRemoteProviderDescriptor[] {
        return [...this.providersByType.values()];
    }

    private requireType(type: string): RegisteredRemoteProviderDescriptor {
        const provider = this.providersByType.get(type);
        if (!provider) throw new Error(`Unsupported type: ${type}`);
        return provider;
    }
}
