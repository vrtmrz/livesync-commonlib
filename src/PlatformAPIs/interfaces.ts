// Isomorphic Utilities

import type { SimpleStore } from "octagonal-wheels/databases/SimpleStoreBase";
import type { APIBase } from "./APIBase";

export const MISSING = Symbol("MISSING");
export type MISSING = typeof MISSING;

export interface IPlatformAPIs<T extends object> extends APIBase<T> {
    crypto: Crypto;
    getPlatformName(): string;
    getPackageVersion(): string;
    getManifestVersion(): string;
}

export interface ISimpleStore<T extends object> extends APIBase<T> {
    getSimpleStore<T>(key: string): SimpleStore<T>;
    dropSimpleStore(key: string): Promise<void>;
}
export interface IConfigUtils<T extends object> extends APIBase<T> {
    setSmallConfig<T>(key: string, value: T): void;
    getSmallConfig<T>(key: string): T | undefined;
    getSmallConfig<T, U>(key: string, def: T | U): T | U;
    deleteSmallConfig(key: string): void;

    setObjectConfig<T>(key: string, value: T): Promise<void>;
    getObjectConfig<T>(key: string): Promise<T | undefined>;
    getObjectConfig<T, U>(key: string, def: T | U): Promise<T | U>;
    deleteObjectConfig(key: string): Promise<void>;
}

export interface IConfirmUtils<T extends object> extends APIBase<T> {
    askString(title: string, key: string, placeholder: string, isPassword?: boolean): Promise<string | false>;

    askYesNo(
        title: string,
        message: string,
        option: { title?: string; defaultOption?: "Yes" | "No"; timeout?: number }
    ): Promise<"yes" | "no">;

    askOptions<T extends string[]>(
        title: string,
        message: string,
        buttons: T,
        options: { defaultAction: T[number]; timeout?: number }
    ): Promise<T[number] | false>;

    askOptionsWithMessage<T extends string[]>(
        title: string,
        contentMd: string,
        buttons: T[],
        options: {
            defaultAction: T[number];
            timeout?: number;
        }
    ): Promise<T[number] | false>;

    askInPopup(key: string, dialogText: string, anchorCallback: (anchor: HTMLAnchorElement) => void): void;
}

export interface Events {
    emitEvent(event: string, ...args: any[]): void;
    onEvent(event: string, callback: (...args: any[]) => void): void;
    offEvent(event: string, callback: (...args: any[]) => void): void;
}
