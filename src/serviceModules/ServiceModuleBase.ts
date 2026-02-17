// Module which based on service, but not directly related to the core functionality of the plugin,
// such as file handling, database access, etc.
// To avoid circular dependency, please ensure that the dependencies of derived classes are explicitly defined in the constructor.

import type { APIService } from "@lib/services/base/APIService";
import { createInstanceLogFunction } from "@lib/services/lib/logUtils";
export interface ServiceModuleBaseDependencies {
    API: APIService;
}
export abstract class ServiceModuleBase<T extends ServiceModuleBaseDependencies> {
    _log: ReturnType<typeof createInstanceLogFunction>;
    get name() {
        return this.constructor.name;
    }
    constructor(services: T) {
        this._log = createInstanceLogFunction(this.name, services.API);
    }
}
