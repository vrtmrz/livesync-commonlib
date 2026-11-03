import { DirectFileManipulator } from "@vrtmrz/livesync-commonlib";
import type {
    CurrentFileContent,
    CurrentFileMetadata,
    FileMetadataResponse,
    MaterialisedFile,
} from "@vrtmrz/livesync-commonlib/documents";

declare const direct: DirectFileManipulator;
declare const filePath: Parameters<DirectFileManipulator["getMetadata"]>[0];
declare const id: string;
declare const runtimeMetaOnly: boolean;

async function checkDirectReads() {
    const metadata: false | FileMetadataResponse = await direct.getMetadata(filePath);
    const file: false | MaterialisedFile = await direct.getFile(filePath);
    const metadataById: false | CurrentFileMetadata = await direct.getById(id, true);
    const contentById: false | CurrentFileContent = await direct.getById(id, false);
    const runtimeById: false | CurrentFileMetadata | CurrentFileContent = await direct.getById(id, runtimeMetaOnly);

    if (metadata !== false) {
        const revision: string = metadata._rev;
        void revision;
    }
    if (metadataById !== false) {
        const currentMetadata: CurrentFileMetadata = metadataById;
        // @ts-expect-error Current Metadata does not guarantee reconstructed content.
        metadataById.data;
        void currentMetadata;
    }
    if (contentById !== false) {
        const parts: string[] = contentById.data;
        // @ts-expect-error DFM content parts remain an array.
        const scalar: string = contentById.data;
        void [parts, scalar];
    }
    if (runtimeById !== false) {
        // @ts-expect-error A runtime mode can return Metadata without content.
        runtimeById.data;
    }

    void [metadata, file];
}

function checkEnumerationModes() {
    const metadata = direct._enumerate("", "z", { metaOnly: true });
    const content = direct._enumerate("", "z", { metaOnly: false });
    const runtimeMode = direct._enumerate("", "z", { metaOnly: runtimeMetaOnly });
    const metadataRows: AsyncGenerator<CurrentFileMetadata, void, unknown> = metadata;
    const contentRows: AsyncGenerator<CurrentFileContent, void, unknown> = content;
    const eitherRows: AsyncGenerator<CurrentFileMetadata | CurrentFileContent, void, unknown> = runtimeMode;

    const allMetadata = direct.enumerateAllNormalDocs({ metaOnly: true });
    const allContent = direct.enumerateAllNormalDocs({ metaOnly: false });
    const allRuntimeMode = direct.enumerateAllNormalDocs({ metaOnly: runtimeMetaOnly });
    const allMetadataRows: AsyncGenerator<CurrentFileMetadata, void, unknown> = allMetadata;
    const allContentRows: AsyncGenerator<CurrentFileContent, void, unknown> = allContent;
    const allEitherRows: AsyncGenerator<CurrentFileMetadata | CurrentFileContent, void, unknown> = allRuntimeMode;

    void [metadataRows, contentRows, eitherRows, allMetadataRows, allContentRows, allEitherRows];
}

function checkWatchCallbacks() {
    direct.beginWatch(
        (entry) => {
            const parts: string[] = entry.data;
            void parts;
        },
        (metadata) => {
            const chunks: string[] = metadata.children;
            // @ts-expect-error The selection callback receives Metadata, not reconstructed content.
            metadata.data;
            return chunks.length > 0;
        }
    );
}

void [checkDirectReads, checkEnumerationModes, checkWatchCallbacks];
