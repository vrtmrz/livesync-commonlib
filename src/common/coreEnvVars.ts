declare const MANIFEST_VERSION: string | undefined;
declare const PACKAGE_VERSION: string | undefined;

const manifestVersion: string = typeof MANIFEST_VERSION !== "undefined" ? MANIFEST_VERSION : "-";
const packageVersion: string = typeof PACKAGE_VERSION !== "undefined" ? PACKAGE_VERSION : "-";

export { manifestVersion, packageVersion };
