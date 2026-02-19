import type { UXFileInfoStub, FilePath } from "@lib/common/types";
import type { IAPIService, ISettingService, IVaultService } from "./IService";
import { ServiceBase, type ServiceContext } from "./ServiceBase";

export interface VaultServiceDependencies {
    settingService: ISettingService;
    APIService: IAPIService;
}
/**
 * The VaultService provides methods for interacting with the vault (local file system).
 */
export abstract class VaultService<T extends ServiceContext = ServiceContext>
    extends ServiceBase<T>
    implements IVaultService
{
    protected settingService: ISettingService;
    protected APIService: IAPIService;
    get settings() {
        return this.settingService.currentSettings();
    }
    constructor(context: T, dependencies: VaultServiceDependencies) {
        super(context);
        this.settingService = dependencies.settingService;
        this.APIService = dependencies.APIService;
    }
    /**
     * Get the vault name only.
     */
    vaultName(): string {
        return this.APIService.getSystemVaultName();
    }

    /**
     * Get the vault name with additional suffixes.
     */
    getVaultName() {
        return (
            this.vaultName() +
            (this.settings.additionalSuffixOfDatabaseName ? "-" + this.settings.additionalSuffixOfDatabaseName : "")
        );
    }

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
    isFileSizeTooLarge(size: number) {
        const maxSize = this.settings.syncMaxSizeInMB;
        if (maxSize > 0 && size > 0) {
            if (maxSize * 1024 * 1024 < size) {
                return true;
            }
        }
        return false;
    }

    /**
     * Get the currently active file path in the editor, if any.
     */
    abstract getActiveFilePath(): FilePath | undefined;

    /**
     * Check if the vault is on a case-insensitive file system.
     * This is important for certain operating systems like Windows and macOS.
     */
    abstract isStorageInsensitive(): boolean;

    /**
     * Check if the file system should be treated case-insensitively.
     * This is important for certain operating systems like Windows and macOS.
     */
    shouldCheckCaseInsensitively(): boolean {
        // By default, only check if the setting says so.
        // Override this method in subclasses for the platform-specific logic, i.e., checking the underlying file system.
        return !this.settings.handleFilenameCaseSensitive;
    }
}
