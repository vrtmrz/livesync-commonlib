export class ServiceContext {
    // Placeholder for future context properties
}
export abstract class ServiceBase<T extends ServiceContext> {
    protected context: T;
    constructor(context: T) {
        this.context = context;
    }
}
