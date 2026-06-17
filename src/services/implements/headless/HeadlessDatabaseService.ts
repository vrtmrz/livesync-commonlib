import { KeyValueDBService } from "@lib/services/base/KeyValueDBService";
import type { ServiceContext } from "@lib/services/base/ServiceBase";
import { DatabaseService } from "@lib/services/base/DatabaseService.ts";

export class HeadlessDatabaseService<T extends ServiceContext> extends DatabaseService<T> {}

export class HeadlessKeyValueDBService<T extends ServiceContext> extends KeyValueDBService<T> {}
