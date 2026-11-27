import { type Diff, diff_match_patch, DIFF_DELETE, DIFF_INSERT, DIFF_EQUAL } from "diff-match-patch";
import { readString, decodeBinary } from "octagonal-wheels/binary";
import { Logger, LOG_LEVEL_VERBOSE, LOG_LEVEL_INFO } from "octagonal-wheels/common/logger";
import {
    type EntryDoc,
    type FilePathWithPrefix,
    type diff_result_leaf,
    type LoadedEntry,
    MISSING_OR_ERROR,
    NOT_CONFLICTED,
    type DIFF_CHECK_RESULT_AUTO,
} from "@lib/common/types.ts";
import {
    getDocData,
    tryParseJSON,
    generatePatchObj,
    flattenObject,
    applyPatch,
    isSensibleMargeApplicable,
    isObjectMargeApplicable,
} from "@lib/common/utils.ts";
import type { EntryManager } from "@lib/managers/EntryManager/EntryManager.ts";
import { getPathNormalizationVersion, normalisePathForIdentity } from "@lib/common/pathNormalization.ts";
import { isErrorOfMissingDoc } from "@lib/pouchdb/utils_couchdb.ts";
import type { IPathService } from "@lib/services/base/IService.ts";

type AutoMergeOutcomeOK = {
    ok: DIFF_CHECK_RESULT_AUTO;
};

type AutoMergeCanBeDoneByDeletingRev = {
    result: string;
    conflictedRev: string;
    path?: FilePathWithPrefix;
};

type UserActionRequired = {
    leftRev: string;
    rightRev: string;
    leftLeaf: diff_result_leaf | false;
    rightLeaf: diff_result_leaf | false;
};

type MergeLeaves = {
    baseLeaf: diff_result_leaf;
    leftLeaf: diff_result_leaf;
    rightLeaf: diff_result_leaf;
};

type ConflictCandidate = {
    revision: string;
    leaf: diff_result_leaf | false;
};

function revisionGeneration(revision: string): number {
    const generation = Number(revision.split("-", 1)[0]);
    return Number.isFinite(generation) ? generation : Number.MAX_SAFE_INTEGER;
}

function compareConflictCandidates(left: ConflictCandidate, right: ConflictCandidate): number {
    const generationDifference = revisionGeneration(left.revision) - revisionGeneration(right.revision);
    if (generationDifference !== 0) return generationDifference;

    // A missing modification time is reviewed first. It must not acquire
    // accidental priority from PouchDB's internal leaf enumeration order.
    const leftMtime =
        left.leaf === false || !Number.isFinite(left.leaf.mtime) ? Number.NEGATIVE_INFINITY : left.leaf.mtime;
    const rightMtime =
        right.leaf === false || !Number.isFinite(right.leaf.mtime) ? Number.NEGATIVE_INFINITY : right.leaf.mtime;
    const mtimeDifference = leftMtime - rightMtime;
    if (mtimeDifference !== 0) return mtimeDifference;

    // Compare the complete revision IDs by code unit so the final tie-breaker
    // is independent of the host locale.
    if (left.revision < right.revision) return -1;
    if (left.revision > right.revision) return 1;
    return 0;
}

export type AutoMergeResult = Promise<AutoMergeOutcomeOK | AutoMergeCanBeDoneByDeletingRev | UserActionRequired>;

export interface ConflictManagerOptions {
    entryManager: EntryManager;
    pathService: IPathService;
    database: PouchDB.Database<EntryDoc>;
}
export class ConflictManager {
    options: ConflictManagerOptions;
    constructor(options: ConflictManagerOptions) {
        this.options = options;
    }
    get database(): PouchDB.Database<EntryDoc> {
        return this.options.database;
    }

    private haveMatchingStoredPaths(left: diff_result_leaf, right: diff_result_leaf): boolean {
        if (!left.path || !right.path) {
            return false;
        }
        const settings = this.options.entryManager.serviceHost.services.setting.currentSettings();
        const version = getPathNormalizationVersion(settings);
        return normalisePathForIdentity(left.path, version) === normalisePathForIdentity(right.path, version);
    }

    async getConflictedDoc(path: FilePathWithPrefix, rev: string): Promise<false | diff_result_leaf> {
        try {
            const metadata = await this.options.entryManager.getDBEntryMeta(path, { rev }, true, "stored");
            if (!metadata) {
                return false;
            }
            const { storedPath, ...entry } = metadata;
            const doc = await this.options.entryManager.getDBEntryFromMeta({ ...entry, path });
            if (!doc) {
                return false;
            }
            let data = getDocData(doc.data);
            if (doc.datatype == "newnote") {
                data = readString(new Uint8Array(decodeBinary(doc.data)));
            } else if (doc.datatype == "plain") {
                // NO OP.
            }
            return {
                ...(storedPath ? { path: storedPath } : {}),
                datatype: doc.datatype,
                deleted: doc.deleted || doc._deleted,
                ctime: doc.ctime,
                mtime: doc.mtime,
                rev: rev,
                data: data,
            };
        } catch (ex) {
            if (isErrorOfMissingDoc(ex)) {
                return false;
            }
        }
        return false;
    }

    private async readMergeLeaves(
        path: FilePathWithPrefix,
        baseRev: string,
        leftRev: string,
        rightRev: string,
        observed?: UserActionRequired
    ): Promise<MergeLeaves | UserActionRequired> {
        const leftLeaf = observed?.leftLeaf || (await this.getConflictedDoc(path, leftRev));
        const rightLeaf = observed?.rightLeaf || (await this.getConflictedDoc(path, rightRev));
        if (
            leftLeaf &&
            rightLeaf &&
            !leftLeaf.deleted &&
            !rightLeaf.deleted &&
            this.haveMatchingStoredPaths(leftLeaf, rightLeaf)
        ) {
            const baseLeaf = await this.getConflictedDoc(path, baseRev);
            if (baseLeaf) return { baseLeaf, leftLeaf, rightLeaf };
        }
        return { leftRev, rightRev, leftLeaf, rightLeaf };
    }

    async mergeSensibly(
        path: FilePathWithPrefix,
        baseRev: string,
        currentRev: string,
        conflictedRev: string
    ): Promise<Diff[] | false> {
        const leaves = await this.readMergeLeaves(path, baseRev, currentRev, conflictedRev);
        return "baseLeaf" in leaves && this.mergeMarkdownLeaves(leaves);
    }

    private mergeMarkdownLeaves({ baseLeaf, leftLeaf, rightLeaf }: MergeLeaves): Diff[] | false {
        let autoMerge = false;
        // diff between base and each revision
        const dmp = new diff_match_patch();
        const mapLeft = dmp.diff_linesToChars_(baseLeaf.data, leftLeaf.data);
        const diffLeftSrc = dmp.diff_main(mapLeft.chars1, mapLeft.chars2, false);
        dmp.diff_charsToLines_(diffLeftSrc, mapLeft.lineArray);
        const mapRight = dmp.diff_linesToChars_(baseLeaf.data, rightLeaf.data);
        const diffRightSrc = dmp.diff_main(mapRight.chars1, mapRight.chars2, false);
        dmp.diff_charsToLines_(diffRightSrc, mapRight.lineArray);
        function splitDiffPiece(src: Diff[]): Diff[] {
            const ret = [] as Diff[];
            do {
                const d = src.shift();
                if (d === undefined) {
                    return ret;
                }
                const pieces = d[1].split(/([^\n]*\n)/).filter((f) => f != "");
                if (typeof d == "undefined") {
                    break;
                }
                if (d[0] != DIFF_DELETE) {
                    ret.push(...pieces.map((e) => [d[0], e] as Diff));
                }
                if (d[0] == DIFF_DELETE) {
                    const nd = src.shift();

                    if (typeof nd != "undefined") {
                        const piecesPair = nd[1].split(/([^\n]*\n)/).filter((f) => f != "");
                        if (nd[0] == DIFF_INSERT) {
                            // it might be pair
                            for (const pt of pieces) {
                                ret.push([d[0], pt]);
                                const pairP = piecesPair.shift();
                                if (typeof pairP != "undefined") ret.push([DIFF_INSERT, pairP]);
                            }
                            ret.push(...piecesPair.map((e) => [nd[0], e] as Diff));
                        } else {
                            ret.push(...pieces.map((e) => [d[0], e] as Diff));
                            ret.push(...piecesPair.map((e) => [nd[0], e] as Diff));
                        }
                    } else {
                        ret.push(...pieces.map((e) => [0, e] as Diff));
                    }
                }
            } while (src.length > 0);
            return ret;
        }

        const diffLeft = splitDiffPiece(diffLeftSrc);
        const diffRight = splitDiffPiece(diffRightSrc);

        let rightIdx = 0;
        let leftIdx = 0;
        const merged = [] as Diff[];
        autoMerge = true;
        LOOP_MERGE: do {
            if (leftIdx >= diffLeft.length && rightIdx >= diffRight.length) {
                break LOOP_MERGE;
            }
            const leftItem = diffLeft[leftIdx] ?? [0, ""];
            const rightItem = diffRight[rightIdx] ?? [0, ""];
            leftIdx++;
            rightIdx++;
            // Same unchanged line on both sides: keep it once.
            if (leftItem[0] == DIFF_EQUAL && rightItem[0] == DIFF_EQUAL && leftItem[1] == rightItem[1]) {
                merged.push(leftItem);
                continue;
            }
            if (leftItem[0] == DIFF_DELETE && rightItem[0] == DIFF_DELETE && leftItem[1] == rightItem[1]) {
                // Same deletion on both sides is safe. If only one side immediately inserts a replacement,
                // this is a delete-vs-edit overlap and must remain a manual conflict.
                const nextLeftIdx = leftIdx;
                const nextRightIdx = rightIdx;
                const [nextLeftItem, nextRightItem] = [
                    diffLeft[nextLeftIdx] ?? [0, ""],
                    diffRight[nextRightIdx] ?? [0, ""],
                ];
                const nextLeftIsInsert = nextLeftItem[0] == DIFF_INSERT;
                const nextRightIsInsert = nextRightItem[0] == DIFF_INSERT;
                if (nextLeftIsInsert != nextRightIsInsert) {
                    autoMerge = false;
                    break;
                }
                if (nextLeftIsInsert && nextRightIsInsert && nextLeftItem[1] != nextRightItem[1]) {
                    // Both sides replaced the same deleted line differently.
                    autoMerge = false;
                    break;
                }
                merged.push(leftItem);
                continue;
            }
            // Insertions are additive. If both sides inserted different content at the same
            // position, keep both in a deterministic mtime order.
            if (leftItem[0] == DIFF_INSERT && rightItem[0] == DIFF_INSERT) {
                if (leftItem[1] == rightItem[1]) {
                    merged.push(leftItem);
                    continue;
                } else {
                    // sort by file date.
                    if (leftLeaf.mtime <= rightLeaf.mtime) {
                        merged.push(leftItem);
                        merged.push(rightItem);
                        continue;
                    } else {
                        merged.push(rightItem);
                        merged.push(leftItem);
                        continue;
                    }
                }
            }
            // A one-sided insertion does not consume the other side's current line.
            if (leftItem[0] == DIFF_INSERT) {
                rightIdx--;
                merged.push(leftItem);
                continue;
            }
            if (rightItem[0] == DIFF_INSERT) {
                leftIdx--;
                merged.push(rightItem);
                continue;
            }
            // Apart from insertions, mismatched line contents mean the regions are no
            // longer aligned enough for a safe automatic merge.
            if (rightItem[1] != leftItem[1]) {
                //TODO: SHOULD BE PANIC.
                Logger(
                    `MERGING PANIC:${leftItem[0]},${leftItem[1]} == ${rightItem[0]},${rightItem[1]}`,
                    LOG_LEVEL_VERBOSE
                );
                autoMerge = false;
                break LOOP_MERGE;
            }
            if (leftItem[0] == DIFF_DELETE) {
                if (rightItem[0] == DIFF_EQUAL) {
                    // One side deleted a line the other side left unchanged. Prefer the
                    // deletion; final content generation drops DIFF_DELETE entries.
                    merged.push(leftItem);
                    continue;
                } else {
                    //we cannot perform auto merge.
                    autoMerge = false;
                    break LOOP_MERGE;
                }
            }
            if (rightItem[0] == DIFF_DELETE) {
                if (leftItem[0] == DIFF_EQUAL) {
                    // Symmetric safe deletion.
                    merged.push(rightItem);
                    continue;
                } else {
                    //we cannot perform auto merge.
                    autoMerge = false;
                    break LOOP_MERGE;
                }
            }
            Logger(
                `Weird condition:${leftItem[0]},${leftItem[1]} == ${rightItem[0]},${rightItem[1]}`,
                LOG_LEVEL_VERBOSE
            );
            // here is the exception
            break LOOP_MERGE;
        } while (leftIdx < diffLeft.length || rightIdx < diffRight.length);
        if (autoMerge) {
            Logger(`Sensibly merge available`, LOG_LEVEL_VERBOSE);
            return merged;
        } else {
            return false;
        }
    }

    async mergeObject(
        path: FilePathWithPrefix,
        baseRev: string,
        currentRev: string,
        conflictedRev: string
    ): Promise<string | false> {
        const leaves = await this.readMergeLeaves(path, baseRev, currentRev, conflictedRev);
        return "baseLeaf" in leaves && this.mergeObjectLeaves(leaves);
    }

    private mergeObjectLeaves({ baseLeaf, leftLeaf, rightLeaf }: MergeLeaves): string | false {
        try {
            const baseObj = { data: tryParseJSON(baseLeaf.data, {}) } as Record<string | number | symbol, unknown>;
            const leftObj = { data: tryParseJSON(leftLeaf.data, {}) } as Record<string | number | symbol, unknown>;
            const rightObj = { data: tryParseJSON(rightLeaf.data, {}) } as Record<string | number | symbol, unknown>;

            const diffLeft = generatePatchObj(baseObj, leftObj);
            const diffRight = generatePatchObj(baseObj, rightObj);

            // If each value of the same key has been modified, the automatic merge should be prevented.
            //TODO Does it have to be a configurable item?
            const diffSetLeft = new Map(flattenObject(diffLeft));
            const diffSetRight = new Map(flattenObject(diffRight));
            for (const [key, value] of diffSetLeft) {
                if (diffSetRight.has(key)) {
                    if (diffSetRight.get(key) == value) {
                        // No matter, if changed to the same value.
                        diffSetRight.delete(key);
                    }
                }
            }
            for (const [key, value] of diffSetRight) {
                if (diffSetLeft.has(key) && diffSetLeft.get(key) != value) {
                    // Some changes are conflicted
                    Logger(`Conflicted key:${key}`, LOG_LEVEL_VERBOSE);
                    return false;
                }
            }

            const patches = [
                { mtime: leftLeaf.mtime, patch: diffLeft },
                { mtime: rightLeaf.mtime, patch: diffRight },
            ].sort((a, b) => a.mtime - b.mtime);
            let newObj = { ...baseObj };
            for (const patch of patches) {
                newObj = applyPatch(newObj, patch.patch);
            }
            Logger(`Object merge is applicable!`, LOG_LEVEL_VERBOSE);
            return JSON.stringify(newObj.data);
        } catch (ex) {
            Logger("Could not merge object");
            Logger(ex, LOG_LEVEL_VERBOSE);
            return false;
        }
    }
    async tryAutoMergeSensibly(path: FilePathWithPrefix, test: LoadedEntry, conflicts: string[]) {
        const merged = await this.tryMergeConflict(path, test._rev!, conflicts[0]);
        return "result" in merged ? { result: merged.result, conflictedRev: merged.conflictedRev } : false;
    }

    private async tryMergeConflict(
        path: FilePathWithPrefix,
        leftRev: string,
        rightRev: string,
        observed?: UserActionRequired
    ): Promise<AutoMergeCanBeDoneByDeletingRev | UserActionRequired> {
        const conflict: UserActionRequired = observed ?? { leftRev, rightRev, leftLeaf: false, rightLeaf: false };
        const markdown = isSensibleMargeApplicable(path);
        if (!markdown && !isObjectMargeApplicable(path)) return conflict;
        let commonBase = "";
        try {
            const documentId = await this.options.pathService.path2id(path);
            const [currentBranch, conflictedBranch] = await Promise.all([
                this.database.get<EntryDoc>(documentId, { rev: leftRev, revs_info: true }),
                this.database.get<EntryDoc>(documentId, { rev: rightRev, revs_info: true }),
            ]);
            const currentAvailable = new Set(
                (currentBranch._revs_info || [])
                    .filter((revision) => revision.status === "available")
                    .map((revision) => revision.rev)
            );
            commonBase =
                (conflictedBranch._revs_info || [])
                    .filter((revision) => revision.status === "available" && currentAvailable.has(revision.rev))
                    .sort((left, right) => Number(right.rev.split("-")[0]) - Number(left.rev.split("-")[0]))[0]?.rev ??
                "";
        } catch (ex) {
            Logger(`Could not determine the common revision for ${path}`, LOG_LEVEL_VERBOSE);
            Logger(ex, LOG_LEVEL_VERBOSE);
            return conflict;
        }
        if (!commonBase) return conflict;
        const leaves = await this.readMergeLeaves(path, commonBase, leftRev, rightRev, conflict);
        if (!("baseLeaf" in leaves)) return leaves;
        const { leftLeaf, rightLeaf } = leaves;
        const readableConflict = { leftRev, rightRev, leftLeaf, rightLeaf };
        if (observed && leftLeaf.data === rightLeaf.data) return readableConflict;

        if (markdown) {
            const diff = this.mergeMarkdownLeaves(leaves);
            if (diff) {
                Logger(`Sensible merge:${path}`, LOG_LEVEL_INFO);
                const result = diff
                    .filter(([operation]) => operation !== DIFF_DELETE)
                    .map(([, text]) => text)
                    .join("");
                return { result, conflictedRev: rightRev, path: leftLeaf.path };
            }
        } else {
            const result = this.mergeObjectLeaves(leaves);
            if (result !== false) {
                Logger(`Object merge:${path}`, LOG_LEVEL_INFO);
                return { result, conflictedRev: rightRev, path: leftLeaf.path };
            }
        }
        return readableConflict;
    }

    async tryAutoMerge(path: FilePathWithPrefix, enableMarkdownAutoMerge: boolean): AutoMergeResult {
        const test = await this.options.entryManager.getDBEntry(
            path,
            { conflicts: true, revs_info: true },
            false,
            false,
            true
        );
        if (test === false) return { ok: MISSING_OR_ERROR };
        if (test == null) return { ok: MISSING_OR_ERROR };
        if (!test._conflicts) return { ok: NOT_CONFLICTED };
        if (test._conflicts.length == 0) return { ok: NOT_CONFLICTED };
        const conflictCandidates = await Promise.all(
            test._conflicts.map(
                async (revision): Promise<ConflictCandidate> => ({
                    revision,
                    leaf: await this.getConflictedDoc(path, revision),
                })
            )
        );
        conflictCandidates.sort(compareConflictCandidates);
        const leftLeaf = await this.getConflictedDoc(path, test._rev!);
        const { revision: rightRev, leaf: rightLeaf } = conflictCandidates[0];
        const conflict = { leftRev: test._rev!, rightRev, leftLeaf, rightLeaf };
        if (leftLeaf !== false && rightLeaf !== false) {
            if (
                !this.haveMatchingStoredPaths(leftLeaf, rightLeaf) ||
                (leftLeaf.data === rightLeaf.data && leftLeaf.deleted === rightLeaf.deleted)
            ) {
                return conflict;
            }
        }
        if (enableMarkdownAutoMerge) {
            return this.tryMergeConflict(path, conflict.leftRev, rightRev, conflict);
        }
        return conflict;
    }
}
