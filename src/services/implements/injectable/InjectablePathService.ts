import { PathService } from "../../base/PathService";
import type { ServiceContext } from "../../base/ServiceBase";

export class PathServiceCompat<T extends ServiceContext> extends PathService<T> {
    override normalizePath(path: string): string {
        // Turns the path with forward slashes, strip double slashes
        const fPath = path.replace(/\\/g, "/").replace(/\/+/g, "/");
        return fPath;
    }
}
