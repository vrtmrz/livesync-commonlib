import { KeyValueDBService } from "../../base/KeyValueDBService";
import type { ServiceContext } from "../../base/ServiceBase";
import { DatabaseService } from "@lib/services/base/DatabaseService.ts";

export class HeadlessDatabaseService<T extends ServiceContext> extends DatabaseService<T> {}

export class HeadlessKeyValueDBService<T extends ServiceContext> extends KeyValueDBService<T> {}
