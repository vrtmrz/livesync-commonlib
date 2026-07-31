import {
    LOG_LEVEL_INFO,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
    type DocumentID,
    type EntryDoc,
    type EntryLeaf,
    type RemoteDBSettings,
} from "@lib/common/types.ts";
import { Logger } from "@lib/common/logger.ts";
import type { ReplicationCallback, ReplicationStat } from "@lib/replication/LiveSyncAbstractReplicator.ts";
import type { SimpleStore } from "@lib/common/utils.ts";
import { REMOTE_CHUNK_FETCHED } from "@lib/pouchdb/LiveSyncLocalDB.ts";

import { AdaptiveJournalCatalogueV1 } from "./adaptive/AdaptiveJournalCatalogue.ts";
import {
    createAdaptiveJournalObjectChunkDeliveryV1,
    type AdaptiveJournalChunkDeliveryV1,
} from "./adaptive/AdaptiveJournalChunkDelivery.ts";
import type { AdaptiveJournalChunkReaderV1 } from "./adaptive/AdaptiveJournalChunkStore.ts";
import type { AdaptiveJournalDiscoveryStoreV1 } from "./adaptive/AdaptiveJournalDiscoveryStore.ts";
import {
    AdaptiveJournalLocalBindingStoreV1,
    AdaptiveJournalLocalReceiveStateV1,
    AdaptiveJournalLocalWriterStateStoreV1,
    clearAdaptiveJournalLocalStateV1,
} from "./adaptive/AdaptiveJournalLocalState.ts";
import { base64UrlToBytes, bytesEqual } from "./adaptive/AdaptiveJournalBinary.ts";
import { AdaptiveJournalError, type AdaptiveJournalEncryption } from "./adaptive/AdaptiveJournalManifest.ts";
import {
    createAdaptiveJournalObjectCatalogueLoaderV1,
    type AdaptiveJournalCatalogueLoaderV1,
} from "./adaptive/AdaptiveJournalObjectCatalogueLoader.ts";
import { createAdaptiveJournalObjectChunkReaderV1 } from "./adaptive/AdaptiveJournalObjectChunkReader.ts";
import { createAdaptiveJournalObjectEventStoreV1 } from "./adaptive/AdaptiveJournalObjectEventStore.ts";
import { AdaptiveJournalObjectPublicationCacheV1 } from "./adaptive/AdaptiveJournalObjectPublicationCache.ts";
import type { AdaptiveJournalObjectRemoteV1 } from "./adaptive/AdaptiveJournalObjectStore.ts";
import { publishAdaptiveJournalMetadataBatchV1 } from "./adaptive/AdaptiveJournalPublisher.ts";
import {
    openAdaptiveJournalRepositoryV1,
    type AdaptiveJournalManifestRemoteV1,
    type OpenedAdaptiveJournalRepositoryV1,
} from "./adaptive/AdaptiveJournalRepository.ts";
import { receiveAdaptiveJournalV1, type AdaptiveJournalReceivedBatchV1 } from "./adaptive/AdaptiveJournalReceiver.ts";
import {
    publishAdaptiveJournalPendingWriterDescriptorV1,
    stageAdaptiveJournalWriterDescriptorV1,
} from "./adaptive/AdaptiveJournalWriterRegistration.ts";
import { encodeAdaptiveJournalWriterDescriptorV1 } from "./adaptive/AdaptiveJournalWriterDescriptor.ts";
import type { LiveSyncJournalReplicatorEnv } from "./LiveSyncJournalReplicatorEnv.ts";
import {
    JournalStorageFormatMismatchError,
    type IJournalStorage,
    type JournalStorageSetting,
} from "./objectstore/JournalStorageAdapter.ts";
import { journalProtocolConfigurationForSettings } from "./objectstore/JournalStorageConfiguration.ts";

type AdaptiveManifestStorage = IJournalStorage & AdaptiveJournalManifestRemoteV1;
type AdaptiveObjectStorage = AdaptiveManifestStorage & AdaptiveJournalObjectRemoteV1;

interface OpenedAdaptiveJournalClientV1 {
    catalogueLoader: AdaptiveJournalCatalogueLoaderV1;
    chunkDelivery: AdaptiveJournalChunkDeliveryV1;
    chunkReader: AdaptiveJournalChunkReaderV1;
    eventStore: AdaptiveJournalDiscoveryStoreV1;
    receiveState: AdaptiveJournalLocalReceiveStateV1;
    repository: OpenedAdaptiveJournalRepositoryV1;
    writerState: AdaptiveJournalLocalWriterStateStoreV1;
}

interface AdaptiveJournalOpenConfigurationV1 {
    encryption: AdaptiveJournalEncryption;
    expectedRepositoryId: string;
    journalFormat: "adaptive-v1" | "opaque-v1";
    packReadPolicy: "range" | "whole-pack";
    passphrase: string;
    storageIdentity: string;
}

function adaptiveEncryption(settings: RemoteDBSettings): AdaptiveJournalEncryption {
    return settings.encrypt ? "encrypted" : "unencrypted";
}

function sameOpenConfiguration(
    left: AdaptiveJournalOpenConfigurationV1 | undefined,
    right: AdaptiveJournalOpenConfigurationV1
): boolean {
    return (
        left !== undefined &&
        left.encryption === right.encryption &&
        left.expectedRepositoryId === right.expectedRepositoryId &&
        left.journalFormat === right.journalFormat &&
        left.packReadPolicy === right.packReadPolicy &&
        left.passphrase === right.passphrase &&
        left.storageIdentity === right.storageIdentity
    );
}

function requireManifestStorage(storage: IJournalStorage): AdaptiveManifestStorage {
    const candidate = storage as Partial<AdaptiveManifestStorage>;
    if (!candidate.readManifest || !candidate.createManifest || !candidate.verifyCapabilities) {
        throw new Error("Selected Journal storage does not implement the Adaptive manifest contract");
    }
    return storage as AdaptiveManifestStorage;
}

function requireObjectStorage(storage: IJournalStorage): AdaptiveObjectStorage {
    const candidate = storage as Partial<AdaptiveObjectStorage>;
    if (!candidate.createAdaptiveObject || !candidate.readAdaptiveObject || !candidate.listAdaptiveObjects) {
        throw new Error("Selected Journal storage does not implement the Adaptive object contract");
    }
    return storage as AdaptiveObjectStorage;
}

export class AdaptiveJournalSyncCore {
    private opened?: OpenedAdaptiveJournalClientV1;
    private openedConfiguration?: AdaptiveJournalOpenConfigurationV1;
    private requestedStop = false;
    private settings: RemoteDBSettings;
    readonly storage: IJournalStorage;

    constructor(
        settings: RemoteDBSettings,
        private stateStore: SimpleStore<unknown>,
        private env: LiveSyncJournalReplicatorEnv,
        storage: IJournalStorage,
        private readonly resolveHostId: () => Promise<string>,
        public processReplication: ReplicationCallback
    ) {
        this.settings = settings;
        this.storage = storage;
    }

    private get db() {
        return this.env.services.database.localDatabase.localDatabase;
    }

    private updateInfo(info: Partial<ReplicationStat>): void {
        const old = this.env.services.replicator.replicationStatics.value;
        this.env.services.replicator.replicationStatics.value = {
            sent: info.sent ?? old.sent,
            arrived: info.arrived ?? old.arrived,
            maxPullSeq: info.maxPullSeq ?? old.maxPullSeq,
            maxPushSeq: info.maxPushSeq ?? old.maxPushSeq,
            lastSyncPullSeq: info.lastSyncPullSeq ?? old.lastSyncPullSeq,
            lastSyncPushSeq: info.lastSyncPushSeq ?? old.lastSyncPushSeq,
            syncStatus: info.syncStatus ?? old.syncStatus,
        };
    }

    private currentOpenConfiguration(): AdaptiveJournalOpenConfigurationV1 {
        const protocol = journalProtocolConfigurationForSettings(this.settings);
        return {
            encryption: adaptiveEncryption(this.settings),
            expectedRepositoryId: protocol.expectedRepositoryId,
            journalFormat: protocol.journalFormat,
            packReadPolicy: protocol.packReadPolicy,
            passphrase: this.settings.encrypt ? this.settings.passphrase : "",
            storageIdentity: this.storage.storageIdentity,
        };
    }

    private async assertOpenedRepositoryCurrent(opened: OpenedAdaptiveJournalClientV1): Promise<void> {
        const manifest = await requireManifestStorage(this.storage).readManifest();
        if (manifest.status === "failed") {
            throw new AdaptiveJournalError(
                "remote-operation-failed",
                `Could not verify the Adaptive Journal repository: ${manifest.failure.category}`
            );
        }
        if (manifest.status === "missing" || !bytesEqual(manifest.value, opened.repository.bytes)) {
            throw new AdaptiveJournalError(
                "repository-id-mismatch",
                "The Adaptive Journal remote repository was rebuilt while this client was active"
            );
        }
    }

    private async open(): Promise<OpenedAdaptiveJournalClientV1> {
        if (this.opened) {
            await this.assertOpenedRepositoryCurrent(this.opened);
            return this.opened;
        }
        const protocol = journalProtocolConfigurationForSettings(this.settings);
        if (protocol.journalFormat !== "adaptive-v1") {
            throw new JournalStorageFormatMismatchError("adaptive-v1", protocol.journalFormat);
        }
        const remoteFormat = await this.storage.inspectRemoteFormat?.();
        if (remoteFormat === undefined) throw new Error("Journal storage cannot inspect its remote format");
        if (remoteFormat !== "empty" && remoteFormat !== "adaptive-v1") {
            throw new JournalStorageFormatMismatchError("adaptive-v1", remoteFormat);
        }
        const binding = new AdaptiveJournalLocalBindingStoreV1(
            this.stateStore,
            this.storage.storageIdentity,
            adaptiveEncryption(this.settings)
        );
        const repository = await openAdaptiveJournalRepositoryV1({
            additionalRequiredCapabilities: protocol.packReadPolicy === "range" ? ["byte-range"] : [],
            binding,
            expectedRepositoryId: protocol.expectedRepositoryId || undefined,
            intent: remoteFormat === "empty" ? "create-new" : "attach-existing",
            passphrase: this.settings.encrypt ? this.settings.passphrase : undefined,
            remote: requireManifestStorage(this.storage),
        });
        const writerState = new AdaptiveJournalLocalWriterStateStoreV1(this.stateStore, this.storage.storageIdentity);
        const hostId = await this.resolveHostId();
        if (hostId.length === 0) throw new Error("Adaptive Journal requires an initialised host ID");
        let writer = await writerState.initialise(repository.keys, hostId);
        const catalogue = new AdaptiveJournalCatalogueV1();
        const objectStorage = requireObjectStorage(this.storage);
        const publicationCache = new AdaptiveJournalObjectPublicationCacheV1(objectStorage);
        const eventStore = createAdaptiveJournalObjectEventStoreV1({
            catalogue,
            keys: repository.keys,
            publicationCache,
            remote: objectStorage,
        });
        const chunkDelivery = createAdaptiveJournalObjectChunkDeliveryV1({
            catalogue,
            keys: repository.keys,
            publicationCache,
            remote: objectStorage,
        });
        const chunkReader = createAdaptiveJournalObjectChunkReaderV1({
            catalogue,
            remote: objectStorage,
            retrieval: protocol.packReadPolicy,
        });
        const catalogueLoader = createAdaptiveJournalObjectCatalogueLoaderV1({
            catalogue,
            keys: repository.keys,
            remote: objectStorage,
        });
        if (!writer.writerRegistered && !writer.pendingWriterDescriptor) {
            const descriptor = await encodeAdaptiveJournalWriterDescriptorV1({
                hostId,
                keys: repository.keys,
                writerEpoch: writer.writerEpoch,
            });
            await stageAdaptiveJournalWriterDescriptorV1(writerState, repository.keys, descriptor);
            writer = await writerState.load();
        }
        if (writer.pendingWriterDescriptor) {
            const registration = await publishAdaptiveJournalPendingWriterDescriptorV1(
                writerState,
                eventStore,
                repository.keys
            );
            if (registration.status !== "registered") {
                throw new AdaptiveJournalError(
                    "remote-operation-failed",
                    `Adaptive Journal Writer registration did not complete: ${registration.status}`
                );
            }
        }
        const receiveState = new AdaptiveJournalLocalReceiveStateV1(
            this.stateStore,
            this.storage.storageIdentity,
            repository.keys.repositoryId
        );
        this.opened = {
            catalogueLoader,
            chunkDelivery,
            chunkReader,
            eventStore,
            receiveState,
            repository,
            writerState,
        };
        this.openedConfiguration = this.currentOpenConfiguration();
        return this.opened;
    }

    applyNewConfig(
        settings: RemoteDBSettings,
        stateStore: SimpleStore<unknown>,
        env: LiveSyncJournalReplicatorEnv,
        storage: IJournalStorage
    ): void {
        if (storage !== this.storage)
            throw new Error("Adaptive Journal core requires recreation after a provider change");
        const localContextChanged = stateStore !== this.stateStore || env !== this.env;
        this.settings = settings;
        this.stateStore = stateStore;
        this.env = env;
        this.storage.applyNewConfig(settings as JournalStorageSetting);
        if (localContextChanged || !sameOpenConfiguration(this.openedConfiguration, this.currentOpenConfiguration())) {
            this.opened = undefined;
            this.openedConfiguration = undefined;
        }
    }

    async getReplicationPBKDF2Salt(_refresh?: boolean): Promise<Uint8Array<ArrayBuffer>> {
        const opened = await this.open();
        return base64UrlToBytes(opened.repository.manifest.securitySeed) as Uint8Array<ArrayBuffer>;
    }

    async isAvailable(): Promise<boolean> {
        try {
            const format = await this.storage.inspectRemoteFormat?.();
            return format === "empty" || format === "adaptive-v1";
        } catch {
            return false;
        }
    }

    async ensureCheckpointCachesAreFresh(): Promise<void> {
        await this.open();
    }

    private async metadataChanges(since: number | string): Promise<{
        documents: readonly EntryDoc[];
        lastSequence: number | string;
    }> {
        const changes = await this.db.changes({
            attachments: false,
            conflicts: true,
            limit: 100,
            live: false,
            return_docs: true,
            since,
            style: "all_docs",
        });
        if (changes.results.length === 0) return { documents: [], lastSequence: changes.last_seq };
        const revisions = changes.results.flatMap((entry) =>
            entry.changes.map((change) => ({ id: entry.id, rev: change.rev }))
        );
        const fetched = await this.db.bulkGet({ docs: revisions, revs: true });
        const expectedRevisions = new Map<string, number>();
        for (const { id, rev } of revisions) {
            const key = JSON.stringify([id, rev]);
            expectedRevisions.set(key, (expectedRevisions.get(key) ?? 0) + 1);
        }
        const documents: EntryDoc[] = [];
        for (const result of fetched.results) {
            for (const value of result.docs) {
                if ("error" in value) {
                    throw new Error(`Could not fetch local revision for Adaptive Journal publication: ${result.id}`);
                }
                const document = value.ok as EntryDoc;
                const key = JSON.stringify([document._id, document._rev]);
                const expected = expectedRevisions.get(key) ?? 0;
                if (result.id !== document._id || expected === 0) {
                    throw new Error("Local revision fetch returned an unexpected Adaptive Journal document");
                }
                if (expected === 1) expectedRevisions.delete(key);
                else expectedRevisions.set(key, expected - 1);
                documents.push(document);
            }
        }
        if (expectedRevisions.size > 0) {
            throw new Error("Local revision fetch omitted an Adaptive Journal document");
        }
        return {
            documents: documents.filter(({ _id }) => !_id.startsWith("h:")),
            lastSequence: changes.last_seq,
        };
    }

    private async chunkSources(
        documents: readonly EntryDoc[]
    ): Promise<readonly { data: string; localChunkId: DocumentID }[]> {
        const ids = new Set<DocumentID>();
        for (const document of documents) {
            const children = (document as EntryDoc & { children?: unknown }).children;
            if (children === undefined) continue;
            if (!Array.isArray(children) || !children.every((id) => typeof id === "string" && id.startsWith("h:"))) {
                throw new Error("Metadata document has invalid Chunk dependencies");
            }
            for (const id of children) ids.add(id as DocumentID);
        }
        const localChunkIds = [...ids].sort();
        if (localChunkIds.length === 0) return [];
        const rows = await this.db.allDocs({ include_docs: true, keys: localChunkIds });
        return rows.rows.map((row, index) => {
            if (!("doc" in row) || !row.doc || !("data" in row.doc)) {
                throw new Error(`Local Chunk dependency is missing: ${localChunkIds[index]}`);
            }
            return { data: (row.doc as EntryLeaf).data, localChunkId: localChunkIds[index] };
        });
    }

    private async sendLocalJournalWith(opened: OpenedAdaptiveJournalClientV1): Promise<boolean> {
        while (!this.requestedStop) {
            const writer = await opened.writerState.load();
            const changes = await this.metadataChanges(writer.lastLocalSequence ?? 0);
            if (changes.documents.length === 0) {
                if (changes.lastSequence !== (writer.lastLocalSequence ?? 0)) {
                    await opened.writerState.setLastLocalSequence(changes.lastSequence);
                    continue;
                }
                this.updateInfo({ syncStatus: "COMPLETED" });
                return true;
            }
            const result = await publishAdaptiveJournalMetadataBatchV1({
                chunkDelivery: opened.chunkDelivery,
                chunks: await this.chunkSources(changes.documents),
                documents: changes.documents,
                keys: opened.repository.keys,
                remote: opened.eventStore,
                writerState: opened.writerState,
            });
            if (result.status === "recovered") continue;
            if (result.status !== "committed") {
                Logger(`Adaptive Journal publication paused at ${result.status}`, LOG_LEVEL_NOTICE);
                this.updateInfo({ syncStatus: "ERRORED" });
                return false;
            }
            await opened.writerState.setLastLocalSequence(changes.lastSequence);
            this.updateInfo({ sent: result.sequence <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result.sequence) : 0 });
        }
        return false;
    }

    async sendLocalJournal(_showMessage = false): Promise<boolean> {
        this.requestedStop = false;
        this.updateInfo({ syncStatus: "JOURNAL_SEND" });
        try {
            return await this.sendLocalJournalWith(await this.open());
        } catch (error) {
            Logger("Adaptive Journal send failed", LOG_LEVEL_INFO);
            Logger(error, LOG_LEVEL_VERBOSE);
            this.updateInfo({ syncStatus: "ERRORED" });
            return false;
        }
    }

    private async applyReceivedBatch(
        opened: OpenedAdaptiveJournalClientV1,
        batch: AdaptiveJournalReceivedBatchV1
    ): Promise<void> {
        const chunkRows = await this.db.allDocs({ include_docs: false, keys: batch.chunks.map(({ _id }) => _id) });
        const existingChunks = new Set(chunkRows.rows.flatMap((row) => ("error" in row ? [] : [row.id as DocumentID])));
        const chunks = batch.chunks.filter(({ _id }) => !existingChunks.has(_id));
        if (chunks.length > 0) {
            const results = await this.db.bulkDocs<EntryDoc>(chunks, { new_edits: true });
            const failed = new Set(results.filter((result) => "error" in result).map(({ id }) => id));
            for (const chunk of chunks) {
                if (!failed.has(chunk._id)) this.env.services.context.events.emitEvent(REMOTE_CHUNK_FETCHED, chunk);
            }
            if (failed.size > 0) {
                throw new Error(`Could not persist ${failed.size} received Adaptive Journal Chunk(s)`);
            }
        }
        const revisions = batch.documents.reduce<Record<string, string[]>>((acc, document) => {
            acc[document._id] = [...(acc[document._id] ?? []), document._rev];
            return acc;
        }, {});
        const diff = await this.db.revsDiff(revisions);
        const documents = batch.documents.filter(
            (document) => diff[document._id]?.missing?.includes(document._rev) === true
        );
        if (documents.length > 0) {
            const results = await this.db.bulkDocs<EntryDoc>(documents, { new_edits: false });
            const failed = results.filter((result) => "error" in result);
            if (failed.length > 0) {
                throw new Error(`Could not persist ${failed.length} received Adaptive Journal Metadata revision(s)`);
            }
        }
        if (batch.documents.length > 0 && !this.env.services.setting.currentSettings().suspendParseReplicationResult) {
            await this.processReplication(batch.documents as PouchDB.Core.ExistingDocument<EntryDoc>[]);
        }
        await opened.receiveState.accept(batch.writerStreamId, {
            commitDigest: batch.commitDigest,
            sequence: batch.sequence,
        });
    }

    private async receiveRemoteJournalWith(opened: OpenedAdaptiveJournalClientV1): Promise<boolean> {
        const outcome = await receiveAdaptiveJournalV1({
            catalogueLoader: opened.catalogueLoader,
            chunks: opened.chunkReader,
            keys: opened.repository.keys,
            remote: opened.eventStore,
            sink: {
                apply: async (batch) => await this.applyReceivedBatch(opened, batch),
                frontier: async (writerStreamId) => await opened.receiveState.frontier(writerStreamId),
                hasChunks: async (localChunkIds) => {
                    const rows = await this.db.allDocs({ include_docs: false, keys: [...localChunkIds] });
                    if (rows.rows.length !== localChunkIds.length) {
                        throw new Error(
                            "Local database returned an invalid Adaptive Journal Chunk availability result"
                        );
                    }
                    return rows.rows.map((row, index) => "id" in row && row.id === localChunkIds[index]);
                },
            },
        });
        if (outcome.status === "failed") return false;
        this.updateInfo({
            arrived: outcome.appliedBatches,
            syncStatus: outcome.status === "ok" ? "COMPLETED" : "ERRORED",
        });
        return outcome.status === "ok";
    }

    async receiveRemoteJournal(_showMessage = false): Promise<boolean> {
        this.requestedStop = false;
        this.updateInfo({ syncStatus: "JOURNAL_RECEIVE" });
        try {
            return await this.receiveRemoteJournalWith(await this.open());
        } catch (error) {
            Logger("Adaptive Journal receive failed", LOG_LEVEL_INFO);
            Logger(error, LOG_LEVEL_VERBOSE);
            this.updateInfo({ syncStatus: "ERRORED" });
            return false;
        }
    }

    async sync(_showResult = false): Promise<boolean> {
        this.requestedStop = false;
        try {
            const opened = await this.open();
            this.updateInfo({ syncStatus: "JOURNAL_RECEIVE" });
            if (!(await this.receiveRemoteJournalWith(opened))) return false;
            if (this.requestedStop) return false;
            this.updateInfo({ syncStatus: "JOURNAL_SEND" });
            return await this.sendLocalJournalWith(opened);
        } catch (error) {
            Logger("Adaptive Journal synchronisation failed", LOG_LEVEL_INFO);
            Logger(error, LOG_LEVEL_VERBOSE);
            this.updateInfo({ syncStatus: "ERRORED" });
            return false;
        }
    }

    async resetReceivedHistory(): Promise<void> {
        const opened = await this.open();
        await opened.receiveState.clear();
    }

    async resetSentHistory(): Promise<void> {
        const opened = await this.open();
        await opened.writerState.setLastLocalSequence(0);
    }

    async resetCheckpointInfo(): Promise<void> {
        const opened = await this.open();
        await opened.receiveState.clear();
        await opened.writerState.setLastLocalSequence(0);
    }

    resetAllCaches(): void {
        this.opened = undefined;
        this.openedConfiguration = undefined;
    }

    async resetBucket(): Promise<boolean> {
        if (!this.storage.resetJournalStorage) {
            throw new Error("Selected Journal storage does not implement remote rebuilding");
        }
        this.requestedStop = true;
        if (!(await this.storage.resetJournalStorage())) {
            throw new Error("Could not rebuild Adaptive Journal remote storage");
        }
        await clearAdaptiveJournalLocalStateV1(this.stateStore, this.storage.storageIdentity);
        this.opened = undefined;
        this.openedConfiguration = undefined;
        return true;
    }

    requestStop(): void {
        this.requestedStop = true;
    }
}
