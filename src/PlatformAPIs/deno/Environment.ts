import type { IEnvironment as IEnvironment } from "../interfaces";
import { setEnvironmentInstance } from "../Environment.ts";
import { EVENT_DENO_INFO_SUPPLIED, ServerAPIBase } from "./base.ts";
import type { ServerInitOption } from "./base.ts";
import { eventHub } from "../../hub/hub.ts";

let webcrypto: Crypto;
export async function getWebCrypto() {
    if (webcrypto) {
        return webcrypto;
    }
    if (globalThis.crypto) {
        webcrypto = globalThis.crypto;
        return webcrypto;
    } else {
        const module = await import("node:crypto");
        webcrypto = module.webcrypto as Crypto;
        return webcrypto;
    }
}
export declare const PACKAGE_VERSION: string;
export declare const MANIFEST_VERSION: string;

export class Environment extends ServerAPIBase implements IEnvironment<ServerInitOption> {
    _vaultName: string;
    _manifestVersion: string;
    _packageVersion: string;
    constructor(opt: ServerInitOption) {
        super();
        this._vaultName = opt.vaultName;
        this._manifestVersion = opt.manifestVersion || `${MANIFEST_VERSION}` || "0.0.0";
        this._packageVersion = opt.packageVersion || `${PACKAGE_VERSION}` || "0.0.0";
    }
    override async onInit(): Promise<void> {
        this.crypto = await getWebCrypto();
    }
    crypto!: Crypto;
    getPlatformName(): string {
        return "server";
    }
    getPackageVersion(): string {
        return this._packageVersion;
    }
    getManifestVersion(): string {
        return this._manifestVersion;
    }
    getVaultName(): string {
        return this._vaultName;
    }
}

eventHub.onceEvent(EVENT_DENO_INFO_SUPPLIED, (opt: ServerInitOption) => {
    const platformAPI = new Environment(opt);
    void platformAPI.onInit().then(() => setEnvironmentInstance(platformAPI));
});
