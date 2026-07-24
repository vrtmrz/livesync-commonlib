import type PouchDB from "pouchdb-core";

/** A PouchDB constructor whose adapters have been selected by the host runtime. */
export type PouchDBConstructor = typeof PouchDB;
