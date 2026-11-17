import type PouchDB from "pouchdb-core";
import type { EntryDoc } from "../common/types.ts";
import type { DiagnosticDatabaseSource } from "./types.ts";

/** Promise reads used by local diagnostics; a host can supply its owned read boundary. */
type LocalDiagnosticDatabase = Pick<DiagnosticDatabaseSource, "info" | "get"> & {
    allDocs(
        options: PouchDB.Core.AllDocsOptions & Partial<Pick<PouchDB.Core.AllDocsWithinRangeOptions, "startkey">>
    ): Promise<PouchDB.Core.AllDocsResponse<EntryDoc>>;
};

/** Wrap local Promise reads without taking ownership or using chunk caches. */
export function createLocalDiagnosticSource(
    database: LocalDiagnosticDatabase
): DiagnosticDatabaseSource {
    return {
        info: () => database.info(),
        get: (id, options) => database.get(id, options),
        async *enumerateIds() {
            let previous: string | undefined;
            while (true) {
                const page = await database.allDocs({
                    limit: 256,
                    ...(previous === undefined ? {} : { startkey: previous, skip: 1 }),
                });
                for (const row of page.rows) {
                    if (!row.value.deleted) yield row.id;
                }
                if (page.rows.length < 256) return;
                const last = page.rows.at(-1)!.id;
                if (last === previous) throw new Error("Document enumeration did not advance");
                previous = last;
            }
        },
    };
}
