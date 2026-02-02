import type { CouchDBCredentials, EntryDoc } from "@lib/common/types";
import type { IRemoteService } from "./IService";
import { ServiceBase, type ServiceContext } from "./ServiceBase";

/**
 * The RemoteService provides methods for interacting with the remote database.
 */
export abstract class RemoteService<T extends ServiceContext = ServiceContext>
    extends ServiceBase<T>
    implements IRemoteService
{
    /**
     * Connect to the remote database with the provided settings.
     * @param uri  The URI of the remote database.
     * @param auth  The authentication credentials for the remote database.
     * @param disableRequestURI  Whether to disable the request URI.
     * @param passphrase  The passphrase for the remote database.
     * @param useDynamicIterationCount  Whether to use dynamic iteration count.
     * @param performSetup  Whether to perform setup.
     * @param skipInfo  Whether to skip information retrieval.
     * @param compression  Whether to enable compression.
     * @param customHeaders  Custom headers to include in the request.
     * @param useRequestAPI  Whether to use the request API.
     * @param getPBKDF2Salt  Function to retrieve the PBKDF2 salt.
     * Note that this function is used for CouchDB and compatible only.
     */
    abstract connect(
        uri: string,
        auth: CouchDBCredentials,
        disableRequestURI: boolean,
        passphrase: string | false,
        useDynamicIterationCount: boolean,
        performSetup: boolean,
        skipInfo: boolean,
        compression: boolean,
        customHeaders: Record<string, string>,
        useRequestAPI: boolean,
        getPBKDF2Salt: () => Promise<Uint8Array<ArrayBuffer>>
    ): Promise<
        | string
        | {
              db: PouchDB.Database<EntryDoc>;
              info: PouchDB.Core.DatabaseInfo;
          }
    >;

    /**
     * Replicate all local database content to the remote database.
     * @param showingNotice Whether to show a notice to the user.
     * @param sendChunksInBulkDisabled Whether to disable sending chunks in bulk.
     */
    abstract replicateAllToRemote(showingNotice?: boolean, sendChunksInBulkDisabled?: boolean): Promise<boolean>;

    /**
     * Replicate all content from the remote database to the local database.
     * @param showingNotice Whether to show a notice to the user.
     */
    abstract replicateAllFromRemote(showingNotice?: boolean): Promise<boolean>;

    /**
     * Mark the database as locked.
     * @param lockByClean Whether the lock is due to a clean operation (e.g., reset).
     */
    abstract markLocked(lockByClean?: boolean): Promise<void>;

    /**
     * Mark the database as unlocked. Then other clients will be banned to connect until resolved.
     */
    abstract markUnlocked(): Promise<void>;

    /**
     * Mark the database as resolved. Then the client (current device) can be connected.
     */
    abstract markResolved(): Promise<void>;

    /**
     * Try to reset the remote database if possible.
     * Note that all error will be thrown to the caller.
     * @returns Promise<void>
     */
    abstract tryResetDatabase(): Promise<void>;

    /**
     * Try to create the remote database if it does not exist.
     * Note that all error will be thrown to the caller.
     * @returns Promise<void>
     *
     */
    abstract tryCreateDatabase(): Promise<void>;
}
