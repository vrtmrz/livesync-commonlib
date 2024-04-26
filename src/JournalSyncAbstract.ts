import { type DocumentID, type EntryDoc, LOG_LEVEL_INFO, LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE } from "./types";
import { Logger } from "./logger";
import type { ReplicationCallback, ReplicationStat } from "./LiveSyncAbstractReplicator";
import { unique } from "./utils";
import { serialized } from "./lock";
import { wrappedInflate, wrappedDeflate } from "./utils_couchdb"
import { type SimpleStore, type CheckPointInfo, CheckPointInfoDefault } from "./JournalSyncTypes";
import type { LiveSyncJournalReplicatorEnv } from "./LiveSyncJournalReplicator";

export abstract class JournalSyncAbstract {
    id = "";
    key = "";
    bucket = "";
    endpoint = "";
    region: string = "auto";
    db: PouchDB.Database<EntryDoc>;
    hash = "";
    processReplication: ReplicationCallback;
    batchSize = 100;
    env: LiveSyncJournalReplicatorEnv;
    store: SimpleStore<CheckPointInfo>;
    useCustomRequestHandler: boolean;
    requestedStop = false;

    getHash(endpoint: string, bucket: string, region: string) {
        return btoa(encodeURI([endpoint, bucket, region].join()));
    }
    constructor(id: string, key: string, endpoint: string, bucket: string, store: SimpleStore<CheckPointInfo>, env: LiveSyncJournalReplicatorEnv, useCustomRequestHandler: boolean, region: string = "") {
        this.id = id;
        this.key = key;
        this.bucket = bucket;
        this.endpoint = endpoint;
        this.region = region;
        this.db = env.getDatabase();
        this.env = env;
        this.useCustomRequestHandler = useCustomRequestHandler;
        this.processReplication = async (docs) => await env.processReplication(docs);
        this.store = store;
        this.hash = this.getHash(endpoint, bucket, region);
    }
    applyNewConfig(id: string, key: string, endpoint: string, bucket: string, store: SimpleStore<CheckPointInfo>, env: LiveSyncJournalReplicatorEnv, useCustomRequestHandler: boolean, region: string = "") {
        // const hash = this.getHash(endpoint, bucket, region)
        // if (hash != this.hash || useCustomRequestHandler != this.useCustomRequestHandler) {
        // //TODO What should we check? completely forgot.
        this.id = id;
        this.key = key;
        this.bucket = bucket;
        this.endpoint = endpoint;
        this.region = region;
        this.db = env.getDatabase();
        this.env = env;
        this.useCustomRequestHandler = useCustomRequestHandler;
        this.processReplication = async (docs) => await env.processReplication(docs);
        this.store = store;
        this.hash = this.getHash(endpoint, bucket, region)
        // }
    }

    updateInfo(info: Partial<ReplicationStat>) {
        const old = this.env.replicationStat.value;
        this.env.replicationStat.value = {
            sent: info.sent ?? old.sent,
            arrived: info.arrived ?? old.arrived,
            maxPullSeq: info.maxPullSeq ?? old.maxPullSeq,
            maxPushSeq: info.maxPushSeq ?? old.maxPushSeq,
            lastSyncPullSeq: info.lastSyncPullSeq ?? old.lastSyncPullSeq,
            lastSyncPushSeq: info.lastSyncPushSeq ?? old.lastSyncPushSeq,
            syncStatus: info.syncStatus ?? old.syncStatus,
        };
    }
    async updateCheckPointInfo(func: (infoFrom: CheckPointInfo) => CheckPointInfo) {
        const checkPointKey = `bucketsync-checkpoint-${this.hash}` as DocumentID;
        const old = await this.getCheckpointInfo();
        const newInfo = func(old);
        newInfo.receivedFiles = unique(newInfo.receivedFiles);
        newInfo.knownIDs = unique(newInfo.knownIDs);
        newInfo.sentFiles = unique(newInfo.sentFiles);
        await this.store.set(checkPointKey, newInfo);
        return newInfo;
    }

    async getCheckpointInfo(): Promise<CheckPointInfo> {
        const checkPointKey = `bucketsync-checkpoint-${this.hash}` as DocumentID;
        const old = await this.store.get(checkPointKey) || {};
        return { ...CheckPointInfoDefault, ...old };
    }
    async resetCheckpointInfo() {
        await this.updateCheckPointInfo(info => ({ ...CheckPointInfoDefault }));
    }

    abstract resetBucket(): Promise<boolean>;

    abstract uploadJson<T>(key: string, body: any): Promise<T | boolean>;
    abstract downloadJson<T>(key: string): Promise<T | false>;

    abstract uploadFile(key: string, blob: Blob, mime: string): Promise<boolean>;
    abstract downloadFile(key: string): Promise<Uint8Array | false>;
    abstract listFiles(from: string, limit?: number): Promise<string[]>;

    async _createJournalPack(override?: number | string) {
        const checkPointInfo = await this.getCheckpointInfo();
        const from = override || checkPointInfo.lastLocalSeq;
        const knownIDs = new Set(checkPointInfo.knownIDs);
        Logger(`Creating journal pack with ${this.batchSize} rows from seq:${from}`, LOG_LEVEL_VERBOSE);
        let knownKeyCount = 0;
        let sendKeyCount = 0;
        const allChangesTask = this.db.changes({
            live: false,
            since: override || from,
            // include_docs: true,
            conflicts: true,
            limit: this.batchSize,
            return_docs: true,
            // conflicts: true,
            attachments: false,
            style: "all_docs",
            filter: (doc: EntryDoc) => {
                // if (doc._id.startsWith("h:")) {
                //     // Skip chunks
                //     return false;
                // }
                const key = this.getDocKey(doc);
                if (knownIDs.has(key)) {
                    knownKeyCount++;
                    return false;
                }
                sendKeyCount++;
                return true;
            }
        });
        const allChanges = await allChangesTask;
        if (allChanges.results.length == 0) {
            return { changes: [], hasNext: false, packLastSeq: allChanges.last_seq };
        }
        Logger(`${sendKeyCount} items possibly needs to be sent (${knownKeyCount} keys has been received before)`, LOG_LEVEL_VERBOSE);
        const bd = await this.db.bulkGet({
            docs: allChanges.results.map(e => e.changes.map(change => ({ id: e.id, rev: change.rev }))).flat(),
            revs: true,
        })
        const packLastSeq = allChanges.last_seq;
        const dbInfo = await this.db.info();
        const hasNext = packLastSeq < dbInfo.update_seq
        const docs = bd.results.map(e => e.docs).flat();
        const docChanges = docs.filter(e => ("ok" in e)).map(e => (e as any).ok) as (EntryDoc & PouchDB.Core.GetMeta)[];
        // // pick chunks actually using on this batch.
        // const chunksAll = unique(docChanges.map(e => ("children" in e) ? e.children : []).flat())
        // const chunks = chunksAll.filter(e => !knownIDs.has(e));
        // let chunkChanges = [] as (EntryDoc & PouchDB.Core.GetMeta)[];
        // if (chunks.length == 0) {
        //     console.warn(`All chunks used in ${docChanges.length} docs -> ${chunksAll.length} , but needs to send ${chunks.length}`);
        //     // Originally, chunks did not have to be sent in BulkDocs format, but it is more convenient to send them in this form, so that is what is done.
        //     const usedChunksBDs = await this.db.bulkGet({
        //         docs: chunks.map(e => ({ id: e })),
        //         revs: true,
        //     })
        //     const chunkDocs = usedChunksBDs.results.map(e => e.docs).flat();
        //     chunkChanges = chunkDocs.filter(e => ("ok" in e)).map(e => (e as any).ok) as (EntryDoc & PouchDB.Core.GetMeta)[];
        // }
        return { changes: docChanges, hasNext, packLastSeq };
    }

    getDocKey(doc: EntryDoc) {
        if (doc && doc._id.startsWith("h:")) {
            // When leaf, we do not think about revisions.
            return doc._id;
        }
        return doc._id + "-" + doc._rev;
    }

    serializeDoc(doc: EntryDoc): Uint8Array {
        return new TextEncoder().encode(JSON.stringify(doc) + "\n");
    }

    // async queueUploadFile(name: string, blob: Blob) {
    //     // const files = this.env.simpleStore.keys({ from:})
    //     const key = `upload-${name}`;
    //     const old = await this.env.simpleStore.keys(key, key, 1)
    //     if (old.length != 0) {
    //         Logger(`${name} already queued`, LOG_LEVEL_VERBOSE);
    //     }
    //     await this.env.simpleStore.set(key, blob);
    // }
    async sendLocalJournal(showMessage = false) {
        const logLevel = showMessage ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO
        this.requestedStop = false;
        const checkPointInfo = await this.getCheckpointInfo();
        const initialSeq = checkPointInfo.lastLocalSeq as number;
        this.updateInfo({ syncStatus: "STARTED" });
        const ret = await serialized("JournalSync", async () => {
            const max = (await this.db.info()).update_seq as number;
            showMessage = true;
            let latestPackedLastSeq = 0;
            // const maxFileSize = 1024 * 1024 * 20; //(MB)
            let currentLastSeq = undefined as undefined | string | number;
            const uploadCompressedData = async (blobs: Blob[]) => {
                const sendTimeStamp = Date.now();
                for (const blob of blobs) {
                    const key = `${sendTimeStamp}-docs.jsonl.gz`;
                    // Logger(`Sending journal : Uploading ${key}`, logLevel, "sendjournal-file");
                    const mime = "application/jsonl";
                    try {
                        await this.uploadFile(key, blob, mime);
                        await this.updateCheckPointInfo((info) => ({ ...info, sentFiles: [...info.sentFiles, key] }))
                        Logger(`Sending journal : Uploading ${key} done!`, LOG_LEVEL_INFO);
                    } catch (ex) {
                        Logger("Could not send journalPack to the bucket", LOG_LEVEL_NOTICE);
                        Logger(ex, LOG_LEVEL_VERBOSE);
                        return false;
                    }
                }
                return true;
            }

            let isFinished = false;
            currentLastSeq = undefined;
            let totalSendFiles = 0
            const sendData = async (buf: Uint8Array[]) => {
                const blob = new Blob(buf, { type: "application/json" });
                const bin = await wrappedDeflate(new Uint8Array(await blob.arrayBuffer()), { consume: true, level: 8 });
                if (await uploadCompressedData([new Blob([bin])])) {
                    return true;
                } else {
                    Logger("Could not upload compressed data", LOG_LEVEL_NOTICE);
                    return false;
                }
            }
            const maxOutBufLength = 250;
            const maxBinarySize = 1024 * 1024 * 10;

            let binarySize = 0;
            const outBuf = [] as Uint8Array[];

            const sendAndUpdate = async (buf: Uint8Array[], nextLastSeq: number | string, changes: (EntryDoc & PouchDB.Core.GetMeta)[]) => {
                Logger(`Sending journal : ${totalSendFiles++}  (${nextLastSeq} / ${max})`, logLevel, "sendjournal");
                if (!await sendData(buf)) {
                    return false;
                }
                await this.updateCheckPointInfo((info) => ({
                    ...info, lastLocalSeq: nextLastSeq,
                    knownIDs: [...info.knownIDs, ...changes.map(e => this.getDocKey(e))]
                }));
                return true;
            }
            this.updateInfo({ syncStatus: "JOURNAL_SEND" })
            do {
                if (this.requestedStop) {
                    Logger("Sending Journal : Stop requested", logLevel, "sendjournal");
                    return false;
                }

                const { changes, hasNext, packLastSeq } = await this._createJournalPack(currentLastSeq);
                this.updateInfo({ maxPushSeq: max, sent: packLastSeq as number, lastSyncPushSeq: packLastSeq as number })
                for (const row of changes) {
                    const serialized = this.serializeDoc(row)
                    binarySize += serialized.length;
                    outBuf.push(serialized);
                }
                if (!hasNext) {
                    // End of the queue
                    if (outBuf.length > 0) {
                        const sendBuf = [...outBuf];
                        await sendAndUpdate(sendBuf, packLastSeq, changes);
                    }
                    latestPackedLastSeq = packLastSeq as number;
                    isFinished = true;
                    break;
                } else {
                    latestPackedLastSeq = packLastSeq as number;
                    if (outBuf.length > maxOutBufLength || binarySize > maxBinarySize) {
                        const sendBuf = [...outBuf]
                        outBuf.length = 0;
                        binarySize = 0;
                        if (!await sendAndUpdate(sendBuf, packLastSeq, changes)) {
                            Logger(`Upload error!`, LOG_LEVEL_NOTICE)
                            isFinished = true;
                            break;
                        }
                    }
                    currentLastSeq = packLastSeq;
                }
            } while (!isFinished);

            Logger(`Sending journal : Finished! ${latestPackedLastSeq - initialSeq} changes uploaded`, logLevel, "sendjournal");
            return true;
        });
        Logger("Sending Journal Completed", LOG_LEVEL_INFO)
        this.updateInfo({ syncStatus: "COMPLETED" });
        return ret;
    }
    async _getRemoteJournals() {
        const checkPointInfo = await this.getCheckpointInfo();
        const StartAfter = checkPointInfo.receivedFiles.sort(((a, b) => b.localeCompare(a, undefined, { numeric: true })))[0];
        const files = (await this.listFiles(StartAfter)).filter(e => !e.startsWith("_"));
        if (!files) return [];
        return files.sort(((a, b) => a.localeCompare(b, undefined, { numeric: true })));
    }

    processing = new Set<string>();

    async lockAndProcess<T>(name: string, fn: () => Promise<T>) {
        if (this.processing.has(name)) {
            return;
        }
        this.processing.add(name);
        try {
            return await fn();
        } finally {
            this.processing.delete(name);
        }
    }

    async receiveRemoteJournal(showMessage = false) {
        this.updateInfo({ syncStatus: "STARTED" })
        const logLevel = showMessage ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO
        let keys = [] as string[];
        this.requestedStop = false
        return await serialized("JournalSync", async () => {
            Logger("Receiving Journal", logLevel, "receivejournal");
            const processDocuments = async (docs: (PouchDB.Core.PutDocument<EntryDoc> & PouchDB.Core.GetMeta)[]) => {
                let applyTotal = 0;
                let wholeItems = 0;
                try {
                    const docsRevs = docs.map((e: EntryDoc & PouchDB.Core.GetMeta) => ({ [e._id]: e._revisions!.ids.map((rev, i) => `${e._revisions!.start - i}-${rev}`) })).reduce((a, b) => ({ ...a, ...b }), {});
                    const diffRevs = await this.db.revsDiff(docsRevs);
                    const saveDocs = docs.filter(e => (e._id in diffRevs && ("missing" in diffRevs[e._id]) && (diffRevs[e._id].missing?.length || 0) > 0));
                    // Logger(`Applying ${saveDocs.length} of ${docs.length} docs`, LOG_LEVEL_VERBOSE);
                    await this.db.bulkDocs<EntryDoc>(saveDocs, { new_edits: false });
                    await this.processReplication(saveDocs as PouchDB.Core.ExistingDocument<EntryDoc>[]);
                    await this.updateCheckPointInfo((info) => ({
                        ...info, knownIDs: [...info.knownIDs, ...docs.map(e => this.getDocKey(e))],
                    }));
                    applyTotal += saveDocs.length;
                    wholeItems += docs.length;
                    Logger(`Applied ${applyTotal} of ${wholeItems} docs (${wholeItems - applyTotal} skipped)`, LOG_LEVEL_VERBOSE);
                } catch (ex) {
                    Logger(`Applying journal failed`, logLevel);
                    Logger(ex, LOG_LEVEL_VERBOSE);
                }
            }
            const processData = async (buf: Uint8Array[]) => {
                return await serialized("apply-data", async () => {
                    Logger(`Decompressing journal`, LOG_LEVEL_VERBOSE);
                    const blob = new Blob(buf, { "type": "application/jsonl" });
                    const ab = new Uint8Array(await blob.arrayBuffer());
                    if (ab.length == 0) return;
                    let idxFrom = 0;
                    let idxTo = 0;
                    const d = new TextDecoder();
                    const applyBuf = [] as (PouchDB.Core.PutDocument<EntryDoc> & PouchDB.Core.GetMeta)[]
                    do {
                        idxTo = ab.indexOf(0x0a, idxFrom);
                        if (idxTo == -1) {
                            break
                        }
                        const data = JSON.parse(d.decode(ab.slice(idxFrom, idxTo))) as (PouchDB.Core.PutDocument<EntryDoc> & PouchDB.Core.GetMeta);
                        applyBuf.push(data);
                        if (applyBuf.length > 25) {
                            const save = [...applyBuf]
                            applyBuf.length = 0;
                            await processDocuments(save);
                        }
                        idxFrom = idxTo + 1
                    } while (idxTo > 0);
                    if (applyBuf.length > 0) {
                        const save = [...applyBuf]
                        applyBuf.length = 0;
                        await processDocuments(save);
                    }
                });
            }
            this.updateInfo({ syncStatus: "JOURNAL_RECEIVE" })
            const info = await this.getCheckpointInfo();
            const receivedFiles = new Set([...info.receivedFiles]);
            const sentFiles = new Set([...info.sentFiles]);
            do {
                try {
                    Logger("Receiving Journal: Getting remote journals", logLevel, "receivejournal");
                    keys = await this._getRemoteJournals();
                    let i = 0;
                    if (keys.length == 0) break;
                    let task: Promise<void> = Promise.resolve();
                    Logger(`Receiving Journal: ${keys.length} files needs to be received`, logLevel, "receivejournal");
                    for (const key of keys) {
                        i++;
                        this.updateInfo({ maxPullSeq: keys.length, arrived: i, lastSyncPullSeq: i })
                        if (this.requestedStop) {
                            Logger("Receiving Journal : Stop requested", logLevel, "receivejournal");
                            return false;
                        }
                        if (receivedFiles.has(key)) continue;
                        if (sentFiles.has(key)) {
                            // If this device already sent it before, mark it as downloaded.
                            receivedFiles.add(key);
                            await this.updateCheckPointInfo((info) => ({
                                ...info, receivedFiles: [...info.receivedFiles, key]
                            }))
                            continue;
                        }
                        Logger(`Receiving Journal : ${i} / ${keys.length} `, logLevel, "receivejournal");
                        receivedFiles.add(key);
                        Logger(`Receiving Journal : ${i} / ${keys.length} `, logLevel, "receivejournal");
                        await task;
                        const data = await this.downloadFile(key);
                        if (!data) throw new Error(`Cloud not download ${key}`);
                        const following = async () => {
                            const bin = await wrappedInflate(data, { consume: true });
                            await processData([bin]);
                            await this.updateCheckPointInfo((info) => ({
                                ...info, receivedFiles: [...info.receivedFiles, key]
                            }))
                        };
                        task = following();
                    }
                    await task;
                } catch (ex) {
                    Logger("Could not receive remote journal", LOG_LEVEL_NOTICE);
                    Logger(ex, LOG_LEVEL_VERBOSE);
                    return false;
                }
            } while (keys.length > 0);
            Logger(`Receiving Journal: Done`, logLevel, "receivejournal");
            this.updateInfo({ syncStatus: "COMPLETED" })
            return true
        })
    }

    async sync(showResult = false) {
        this.requestedStop = false;
        const receiveResult = await this.receiveRemoteJournal(showResult);
        if (this.requestedStop) return;
        if (!receiveResult) {
            const logLevel = showResult ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO;
            Logger(`Could not receive remote journal, so we prevent sending local journals to prevent unwanted mass transfers`, logLevel);
            return;
        }
        await this.sendLocalJournal(showResult);

    }

    requestStop() {
        this.requestedStop = true;
    }
}