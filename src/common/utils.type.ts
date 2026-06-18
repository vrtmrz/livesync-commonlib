// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Constructor type for generic error classes
export type Constructor<T> = new (...args: any[]) => T;
