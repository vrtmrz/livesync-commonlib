import { handlers } from "@lib/services/lib/HandlerUtils";
import type { IFileProcessingService } from "./IService";
import { ServiceBase, type ServiceContext } from "./ServiceBase";

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
     * Process a file event item optionally, if any handler is registered.
     * i.e., hidden files synchronisation or customisation sync.
     */
    readonly processOptionalFileEvent = handlers<IFileProcessingService>().anySuccess("processOptionalFileEvent");

    /**
     * Commit any pending file events that have been queued for processing.
     */
    readonly commitPendingFileEvents = handlers<IFileProcessingService>().bailFirstFailure("commitPendingFileEvents");
}
