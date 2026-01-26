import type { DocumentID, EntryHasPath, FilePathWithPrefix, FilePath } from "@lib/common/types";
import type { IPathService } from "./IService";
import { ServiceBase, type ServiceContext } from "./ServiceBase";

/**
 * The PathService provides methods for converting between file paths and document IDs.
 * This class would be migrated to the new logic later.
 */
export abstract class PathService<T extends ServiceContext = ServiceContext>
    extends ServiceBase<T>
    implements IPathService
{
    /**
     * Convert a document ID or entry to a virtual file path.
     * @param id A document ID. Nowadays, it is mostly not the same as the file path.
     * If the document has `_` prefixed, saved as `/_`.
     * @param entry An entry object. If provided, it can be used to get the path directly.
     * @param stripPrefix Whether to strip the prefix from the path.
     */
    abstract id2path(id: DocumentID, entry?: EntryHasPath, stripPrefix?: boolean): FilePathWithPrefix;

    /**
     * Convert a virtual file path to a document ID (with prefix if any).
     * @param filename A file path with or without prefix.
     * @param prefix The prefix to use for the document ID.
     */
    abstract path2id(filename: FilePathWithPrefix | FilePath, prefix?: string): Promise<DocumentID>;
}
