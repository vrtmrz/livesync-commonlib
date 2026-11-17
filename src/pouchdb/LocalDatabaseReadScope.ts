/**
 * Owns caller waits for reads tied to one local database lifetime.
 *
 * Closing the scope rejects pending caller waits and prevents new operations from
 * starting. It does not cancel database I/O which has already started.
 */
export class LocalDatabaseReadScope {
    private readonly pendingReads = new Set<(error: Error) => void>();
    private closedError: Error | undefined;

    /** Whether this scope has stopped accepting reads. */
    get isClosed(): boolean {
        return this.closedError !== undefined;
    }

    /**
     * Starts a read while this scope is open and returns the caller's wait for its result.
     *
     * Closing the scope ends this wait without cancelling underlying database I/O.
     */
    run<T>(operation: () => Promise<T>): Promise<T> {
        const closedError = this.closedError;
        if (closedError) {
            return Promise.reject(closedError);
        }

        return new Promise<T>((resolve, reject) => {
            const rejectPendingRead = (error: Error) => {
                reject(error);
            };
            this.pendingReads.add(rejectPendingRead);

            let operationPromise: Promise<T>;
            try {
                operationPromise = operation();
            } catch (error) {
                this.pendingReads.delete(rejectPendingRead);
                reject(error);
                return;
            }

            void Promise.resolve(operationPromise).then(
                (value) => {
                    this.pendingReads.delete(rejectPendingRead);
                    resolve(value);
                },
                (error: unknown) => {
                    this.pendingReads.delete(rejectPendingRead);
                    reject(error);
                }
            );
        });
    }

    /**
     * Stops new reads and rejects pending caller waits.
     *
     * Database I/O already started by those reads continues in the background.
     */
    close(): void {
        if (this.closedError) {
            return;
        }

        const error = new Error("Local database reads have stopped.");
        this.closedError = error;
        for (const rejectPendingRead of this.pendingReads) {
            rejectPendingRead(error);
        }
        this.pendingReads.clear();
    }
}
