import type { DocumentID, EntryHasPath, FilePathWithPrefix, FilePath, AnyEntry } from "@lib/common/types";
import type { IPathService, ISettingService } from "./IService";
import { ServiceBase, type ServiceContext } from "./ServiceBase";
import { addPrefix, id2path_base, path2id_base } from "../../string_and_binary/path";
import { isInternalMetadata, stripInternalMetadataPrefix } from "../../common/typeUtils";

export interface PathServiceDependencies {
    settingService: ISettingService;
}
/**
 * The PathService provides methods for converting between file paths and document IDs.
 * This class would be migrated to the new logic later.
 */
export abstract class PathService<T extends ServiceContext = ServiceContext>
    extends ServiceBase<T>
    implements IPathService
{
    protected settingService: ISettingService;
    protected abstract normalizePath(path: string): string;
    get settings() {
        return this.settingService.currentSettings();
    }
    constructor(context: T, dependencies: PathServiceDependencies) {
        super(context);
        this.settingService = dependencies.settingService;
    }
    private _id2path(id: DocumentID, entry?: EntryHasPath): FilePathWithPrefix {
        const filename = id2path_base(id, entry);
        const temp = filename.split(":");
        const path = temp.pop();
        const normalizedPath = this.normalizePath(path as FilePath);
        temp.push(normalizedPath);
        const fixedPath = temp.join(":") as FilePathWithPrefix;
        return fixedPath;
    }
    private async _path2id(
        filename: FilePathWithPrefix | FilePath,
        obfuscatePassphrase: string | false,
        caseInsensitive: boolean
    ): Promise<DocumentID> {
        const temp = filename.split(":");
        const path = temp.pop();
        const normalizedPath = this.normalizePath(path as FilePath);
        temp.push(normalizedPath);
        const fixedPath = temp.join(":") as FilePathWithPrefix;

        const out = await path2id_base(fixedPath, obfuscatePassphrase, caseInsensitive);
        return out;
    }
    /**
     * Convert a document ID or entry to a virtual file path.
     * @param id A document ID. Nowadays, it is mostly not the same as the file path.
     * If the document has `_` prefixed, saved as `/_`.
     * @param entry An entry object. If provided, it can be used to get the path directly.
     * @param stripPrefix Whether to strip the prefix from the path.
     */
    id2path(id: DocumentID, entry?: EntryHasPath, stripPrefix?: boolean): FilePathWithPrefix {
        const tempId = this._id2path(id, entry);
        if (stripPrefix && isInternalMetadata(tempId)) {
            const out = stripInternalMetadataPrefix(tempId);
            return out;
        }
        return tempId;
    }

    /**
     * Convert a virtual file path to a document ID (with prefix if any).
     * @param filename A file path with or without prefix.
     * @param prefix The prefix to use for the document ID.
     */
    async path2id(filename: FilePathWithPrefix | FilePath, prefix?: string): Promise<DocumentID> {
        const destPath = addPrefix(filename, prefix ?? "");
        const setting = this.settings;
        return await this._path2id(
            destPath,
            setting.usePathObfuscation ? setting.passphrase : "",
            !setting.handleFilenameCaseSensitive
        );
    }

    getPath(entry: AnyEntry): FilePathWithPrefix {
        return this.id2path(entry._id, entry);
    }
}
