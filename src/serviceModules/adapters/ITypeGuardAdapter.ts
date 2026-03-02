/**
 * Type guard adapter interface
 * Provides runtime type checking for native file system objects
 */
export interface ITypeGuardAdapter<TNativeFile = any, TNativeFolder = any> {
    /**
     * Check if the given object is a file
     */
    isFile(file: any): file is TNativeFile;

    /**
     * Check if the given object is a folder
     */
    isFolder(item: any): item is TNativeFolder;
}
