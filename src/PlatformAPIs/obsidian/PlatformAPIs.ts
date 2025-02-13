import { EVENT_APP_SUPPLIED, ObsidianAPIBase, type ObsidianInitOptions } from "./base";
import type { IPlatformAPIs } from "../interfaces";
import { Platform, type App } from "obsidian";
import { eventHub } from "../../hub/hub";
import { promiseWithResolver } from "octagonal-wheels/promises";

let webcrypto: Crypto;
export async function getWebCrypto() {
    if (webcrypto) {
        return webcrypto;
    }
    if (globalThis.crypto) {
        webcrypto = globalThis.crypto;
        return webcrypto;
    } else {
        const module = await import("crypto");
        webcrypto = module.webcrypto as Crypto;
        return webcrypto;
    }
}
export function getPlatformName() {
    if (Platform.isAndroidApp) {
        return "android-app";
    } else if (Platform.isIosApp) {
        return "ios";
    } else if (Platform.isMacOS) {
        return "macos";
    } else if (Platform.isMobileApp) {
        return "mobile-app";
    } else if (Platform.isMobile) {
        return "mobile";
    } else if (Platform.isSafari) {
        return "safari";
    } else if (Platform.isDesktop) {
        return "desktop";
    } else if (Platform.isDesktopApp) {
        return "desktop-app";
    } else {
        return "unknown-obsidian";
    }
}

export declare const PACKAGE_VERSION: string;
export declare const MANIFEST_VERSION: string;

export class PlatformAPIs extends ObsidianAPIBase implements IPlatformAPIs<ObsidianInitOptions> {
    async onInit(): Promise<void> {
        this.crypto = await getWebCrypto();
    }
    crypto!: Crypto;
    getPlatformName(): string {
        return getPlatformName();
    }
    getPackageVersion(): string {
        const packageVersion: string = `${PACKAGE_VERSION}` || "0.0.0";
        return packageVersion;
    }
    getManifestVersion(): string {
        const manifestVersion: string = `${MANIFEST_VERSION}` || "0.0.0";
        return manifestVersion;
    }
    getVaultName(): string {
        return this.app.vault.getName();
    }
}

const p = promiseWithResolver<PlatformAPIs>();
eventHub.onceEvent(EVENT_APP_SUPPLIED, (app: App) => {
    const platformAPI = new PlatformAPIs({ app });
    void platformAPI.onInit().then(() => p.resolve(platformAPI));
});

export function getPlatformAPI() {
    return p.promise;
}
