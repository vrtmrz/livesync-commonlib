import { describe, expect, it, vi } from "vitest";

import {
    DEFAULT_SETTINGS,
    REMOTE_MINIO,
    REMOTE_WEBDAV,
    hasConfiguredRemote,
    isJournalRemoteType,
    type RemoteDBSettings,
} from "@lib/common/types.ts";
import type { LiveSyncJournalReplicatorEnv } from "../LiveSyncJournalReplicatorEnv.ts";
import type { IJournalStorage } from "./JournalStorageAdapter.ts";
import {
    createJournalStorageAdapter,
    getJournalRemoteDisplayName,
    inspectJournalStorageConnectivity,
    isJournalStorageAdapterCompatible,
    testJournalStorageConnectivity,
} from "./JournalStorageAdapterFactory.ts";

const env = { services: { API: {} } } as unknown as LiveSyncJournalReplicatorEnv;

function s3Settings(overrides: Partial<RemoteDBSettings> = {}): RemoteDBSettings {
    return {
        ...DEFAULT_SETTINGS,
        remoteType: REMOTE_MINIO,
        ...overrides,
    } as RemoteDBSettings;
}

function webDAVSettings(overrides: Partial<RemoteDBSettings> = {}): RemoteDBSettings {
    return {
        ...DEFAULT_SETTINGS,
        remoteType: REMOTE_WEBDAV,
        webDAVactiveConnectionURI:
            "sls+webdav://user:secret@example.invalid/remote.php/dav?prefix=vault%2F&insecure=true",
        ...overrides,
    } as RemoteDBSettings;
}

describe("JournalStorageAdapterFactory", () => {
    it("creates the S3 adapter and recognises its provider contract", () => {
        const settings = s3Settings();
        const storage = createJournalStorageAdapter(settings, env);

        expect(storage.kind).toBe("s3");
        expect(isJournalStorageAdapterCompatible(storage, settings)).toBe(true);
    });

    it("creates the WebDAV adapter and exposes a non-secret display name", () => {
        const settings = webDAVSettings();
        const storage = createJournalStorageAdapter(settings, env);

        expect(storage.kind).toBe("webdav");
        expect(isJournalStorageAdapterCompatible(storage, settings)).toBe(true);
        expect(getJournalRemoteDisplayName(settings)).toBe("http://example.invalid/remote.php/dav");
        expect(
            getJournalRemoteDisplayName(webDAVSettings({ webDAVactiveConnectionURI: "sls+webdav:example.invalid/dav" }))
        ).toBe("WebDAV");
    });

    it("does not treat an adapter for a different provider as compatible", () => {
        const storage = createJournalStorageAdapter(s3Settings(), env);

        expect(isJournalStorageAdapterCompatible(storage, webDAVSettings())).toBe(false);
    });

    it("requires connection fields belonging to the selected remote type", () => {
        expect(hasConfiguredRemote(webDAVSettings())).toBe(true);
        expect(
            hasConfiguredRemote(
                webDAVSettings({
                    bucket: "unrelated-bucket",
                    endpoint: "https://s3.example.invalid",
                    webDAVactiveConnectionURI: "",
                })
            )
        ).toBe(false);
        expect(isJournalRemoteType(REMOTE_MINIO)).toBe(true);
        expect(isJournalRemoteType(REMOTE_WEBDAV)).toBe(true);
        expect(isJournalRemoteType(DEFAULT_SETTINGS.remoteType)).toBe(false);
    });

    it("rejects a remote type which this delivery does not implement", () => {
        expect(() => createJournalStorageAdapter(DEFAULT_SETTINGS, env)).toThrow("Unsupported Journal remote type");
    });

    it("does not repeat an Opaque listing after remote format inspection", async () => {
        const storage = {
            kind: "s3",
            inspectRemoteFormat: vi.fn(async () => "empty" as const),
            listFiles: vi.fn(async () => []),
        } as unknown as IJournalStorage;
        const settings = s3Settings();

        await expect(inspectJournalStorageConnectivity(storage, settings)).resolves.toEqual({
            available: true,
            remoteFormat: "empty",
        });
        expect(storage.inspectRemoteFormat).toHaveBeenCalledOnce();
        expect(storage.listFiles).not.toHaveBeenCalled();
    });

    it("retains the legacy Opaque listing check for adapters without format inspection", async () => {
        const storage = {
            kind: "s3",
            listFiles: vi.fn(async () => []),
        } as unknown as IJournalStorage;
        const settings = s3Settings();

        await expect(testJournalStorageConnectivity(storage, settings)).resolves.toBe(true);
        expect(storage.listFiles).toHaveBeenCalledWith("", 1);
    });

    it.each([
        {
            expectedMessage: "Opaque Journal connections cannot carry Adaptive repository options",
            overrides: { journalFormat: "opaque-v1", packReadPolicy: "range" },
        },
        {
            expectedMessage: "expectedRepositoryId must be a canonical base64url-encoded 32-byte value",
            overrides: { expectedRepositoryId: "AA", journalFormat: "adaptive-v1" },
        },
    ] as const)("rejects inconsistent persisted protocol settings", async ({ expectedMessage, overrides }) => {
        const storage = {
            kind: "s3",
            inspectRemoteFormat: vi.fn(async () => "empty" as const),
        } as unknown as IJournalStorage;

        await expect(inspectJournalStorageConnectivity(storage, s3Settings(overrides))).rejects.toThrow(
            expectedMessage
        );
    });

    it.each(["whole-pack", "range"] as const)(
        "reports required and optional Adaptive capabilities for the %s retrieval policy",
        async (packReadPolicy) => {
            const storage = {
                kind: "s3",
                inspectRemoteFormat: vi.fn(async () => "empty" as const),
                verifyCapabilities: vi.fn(async () => ({ status: "verified" as const })),
            } as unknown as IJournalStorage;
            const settings = s3Settings({ journalFormat: "adaptive-v1", packReadPolicy });

            await expect(inspectJournalStorageConnectivity(storage, settings)).resolves.toEqual({
                adaptiveCapabilities: {
                    byteRange: { status: "verified" },
                    required: { status: "verified" },
                },
                available: true,
                remoteFormat: "empty",
            });
            expect(storage.verifyCapabilities).toHaveBeenCalledWith([
                "binary-fidelity",
                "byte-range",
                "complete-listing",
                "conditional-create",
                "delete-visibility",
                "read-after-write",
            ]);
        }
    );

    it.each([
        { available: true, packReadPolicy: "whole-pack" },
        { available: false, packReadPolicy: "range" },
    ] as const)(
        "treats unsupported optional Range as available=$available for $packReadPolicy retrieval",
        async ({ available, packReadPolicy }) => {
            const storage = {
                kind: "webdav",
                inspectRemoteFormat: vi.fn(async () => "empty" as const),
                verifyCapabilities: vi.fn(async () => ({ missing: ["byte-range"], status: "unsupported" as const })),
            } as unknown as IJournalStorage;

            await expect(
                inspectJournalStorageConnectivity(
                    storage,
                    webDAVSettings({ journalFormat: "adaptive-v1", packReadPolicy })
                )
            ).resolves.toEqual({
                adaptiveCapabilities: {
                    byteRange: { missing: ["byte-range"], status: "unsupported" },
                    required: { status: "verified" },
                },
                available,
                remoteFormat: "empty",
            });
        }
    );

    it("reports missing required semantics without claiming that Range was checked", async () => {
        const storage = {
            kind: "webdav",
            inspectRemoteFormat: vi.fn(async () => "empty" as const),
            verifyCapabilities: vi.fn(async () => ({
                missing: ["conditional-create"],
                status: "unsupported" as const,
            })),
        } as unknown as IJournalStorage;

        await expect(
            inspectJournalStorageConnectivity(
                storage,
                webDAVSettings({ journalFormat: "adaptive-v1", packReadPolicy: "whole-pack" })
            )
        ).resolves.toEqual({
            adaptiveCapabilities: {
                byteRange: { status: "not-checked" },
                required: { missing: ["conditional-create"], status: "unsupported" },
            },
            available: false,
            remoteFormat: "empty",
        });
    });

    it("preserves a typed remote failure instead of reporting unsupported semantics", async () => {
        const failure = { category: "authentication" as const, retry: "never" as const };
        const storage = {
            kind: "webdav",
            inspectRemoteFormat: vi.fn(async () => "empty" as const),
            verifyCapabilities: vi.fn(async () => ({ failure, status: "failed" as const })),
        } as unknown as IJournalStorage;

        await expect(
            inspectJournalStorageConnectivity(storage, webDAVSettings({ journalFormat: "adaptive-v1" }))
        ).resolves.toEqual({
            adaptiveCapabilities: {
                byteRange: { status: "not-checked" },
                required: { failure, status: "failed" },
            },
            available: false,
            remoteFormat: "empty",
        });
    });

    it("does not accept Adaptive mode when the adapter cannot verify its semantics", async () => {
        const storage = {
            kind: "s3",
            inspectRemoteFormat: vi.fn(async () => "empty" as const),
        } as unknown as IJournalStorage;

        await expect(
            inspectJournalStorageConnectivity(storage, s3Settings({ journalFormat: "adaptive-v1" }))
        ).resolves.toEqual({
            adaptiveCapabilities: {
                byteRange: { status: "not-checked" },
                required: {
                    missing: [
                        "binary-fidelity",
                        "complete-listing",
                        "conditional-create",
                        "delete-visibility",
                        "read-after-write",
                    ],
                    status: "unsupported",
                },
            },
            available: false,
            remoteFormat: "empty",
        });
    });

    it.each([
        { configured: "opaque-v1", detected: "adaptive-v1" },
        { configured: "opaque-v1", detected: "mixed" },
        { configured: "adaptive-v1", detected: "opaque-v1" },
        { configured: "adaptive-v1", detected: "mixed" },
    ] as const)(
        "rejects a $detected remote selected as $configured before any capability probe",
        async ({ configured, detected }) => {
            const verifyCapabilities = vi.fn();
            const storage = {
                kind: "s3",
                inspectRemoteFormat: vi.fn(async () => detected),
                verifyCapabilities,
            } as unknown as IJournalStorage;

            await expect(
                inspectJournalStorageConnectivity(storage, s3Settings({ journalFormat: configured }))
            ).resolves.toEqual({ available: false, remoteFormat: detected });
            expect(verifyCapabilities).not.toHaveBeenCalled();
        }
    );
});
