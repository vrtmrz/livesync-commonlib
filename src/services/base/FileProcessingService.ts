import { handlers } from "@lib/services/lib/HandlerUtils";
import type { IFileProcessingService } from "./IService";
import { ServiceBase, type ServiceContext } from "./ServiceBase";
import { reactiveSource } from "octagonal-wheels/dataobject/reactive";

/**
 * File processing service handles file events and processes them accordingly.
 */
export class FileProcessingService<T extends ServiceContext = ServiceContext>
    extends ServiceBase<T>
    implements IFileProcessingService
{
    /**
     * Process a file event item by the registered handlers.
     */
    readonly processFileEvent = handlers<IFileProcessingService>().anySuccess("processFileEvent");

    /**
     * Dispatch a legacy optional notification, without confirming persistence.
     * i.e., hidden files synchronisation or customisation sync.
     */
    readonly processOptionalFileEvent = handlers<IFileProcessingService>().anySuccess("processOptionalFileEvent");

    /**
     * Complete optional file operations through the first applicable handler.
     * Hosts migrate all optional providers together. Once any typed provider is
     * registered, dispatch uses this contract exclusively.
     */
    readonly processOptionalFileEventWithResult? = handlers<IFileProcessingService>().firstHandled(
        "processOptionalFileEventWithResult"
    );

    /**
     * Commit any pending file events that have been queued for processing.
     */
    readonly commitPendingFileEvents = handlers<IFileProcessingService>().bailFirstFailure("commitPendingFileEvents");
    batched = reactiveSource(0);
    totalQueued = reactiveSource(0);
    processing = reactiveSource(0);
    totalStorageFileEventCount: number = 0;
    onStorageFileEvent() {
        this.totalStorageFileEventCount++;
    }
}
