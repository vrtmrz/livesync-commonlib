import type { ServiceContext } from "../../base/ServiceBase";
import { KeyValueDBService } from "../../base/KeyValueDBService";
import { DatabaseService } from "@lib/services/base/DatabaseService.ts";

export class BrowserDatabaseService<T extends ServiceContext> extends DatabaseService<T> {}

export class BrowserKeyValueDBService<T extends ServiceContext> extends KeyValueDBService<T> {}
