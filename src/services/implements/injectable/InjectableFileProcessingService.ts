import { FileProcessingService } from "../../base/FileProcessingService";
import type { ServiceContext } from "../../base/ServiceBase";

export class InjectableFileProcessingService<T extends ServiceContext> extends FileProcessingService<T> {}
