import type { UXFileInfoStub, FilePath } from "@lib/common/types";
import type { IVaultService } from "./IService";
import { ServiceBase, type ServiceContext } from "./ServiceBase";

/**
 * The VaultService provides methods for interacting with the vault (local file system).
 */
export abstract class VaultService<T extends ServiceContext = ServiceContext>
    extends ServiceBase<T>
    implements IVaultService
{
    /**
     * Get the vault name only.
     */
    abstract vaultName(): string;

    /**
     * Get the vault name with additional suffixes.
     */
    abstract getVaultName(): string;

    /**
     * Scan the vault for changes (especially for changes during the plug-in were not running).
     * @param showingNotice Whether to show a notice to the user.
     * @param ignoreSuspending Whether to ignore any suspending state.
     */
    abstract scanVault(showingNotice?: boolean, ignoreSuspending?: boolean): Promise<boolean>;

    /**
     * Check if a file is ignored by the ignore file (e.g., .gitignore, .obsidianignore).
     * @param file The file path or file info stub to check.
     */
    abstract isIgnoredByIgnoreFile(file: string | UXFileInfoStub): Promise<boolean>;

    /**
     * Mark the file list as possibly changed, so that the next operation will re-scan the vault.
     */
    abstract markFileListPossiblyChanged(): void;

    /**
     * Check if a file is a target file for synchronisation.
     * @param file The file path or file info stub to check.
     * @param keepFileCheckList Whether to keep the file in the check list.
     */
    abstract isTargetFile(file: string | UXFileInfoStub, keepFileCheckList?: boolean): Promise<boolean>;

    /**
     * Check if a filesize is too large against the current settings.
     * @param size The file size to check.
     */
    abstract isFileSizeTooLarge(size: number): boolean;

    /**
     * Get the currently active file path in the editor, if any.
     */
    abstract getActiveFilePath(): FilePath | undefined;

    /**
     * Check if the vault is on a case-insensitive file system.
     * This is important for certain operating systems like Windows and macOS.
     */
    abstract isStorageInsensitive(): boolean;
}
