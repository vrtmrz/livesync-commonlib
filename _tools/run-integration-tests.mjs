import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("..", import.meta.url));
const composeFile = fileURLToPath(new URL("../test/integration/compose.yml", import.meta.url));
const vitestCli = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const manageServices = process.argv.includes("--manage-services");

const managedEnvironment = {
    hostname: "http://127.0.0.1:5989/",
    username: "admin",
    password: "testpassword",
    minioEndpoint: "http://127.0.0.1:9000",
    accessKey: "minioadmin",
    secretKey: "minioadmin",
    bucketName: "livesync-test-bucket",
    webdavEndpoint: "http://127.0.0.1:8088/dav",
};
const integrationEnvironment = manageServices
    ? { ...process.env, ...managedEnvironment }
    : { ...managedEnvironment, ...process.env };

function run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: root,
            stdio: "inherit",
            ...options,
        });
        child.once("error", reject);
        child.once("close", (code, signal) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(
                new Error(
                    `${command} ${args.join(" ")} ${signal ? `was terminated by ${signal}` : `exited with ${code}`}`
                )
            );
        });
    });
}

async function waitForHttpService(name, url, options = {}) {
    const deadline = Date.now() + 60_000;

    while (Date.now() < deadline) {
        try {
            const response = await fetch(url, options);
            if (response.ok) return;
        } catch {
            // The service is still starting.
        }
        await delay(1_000);
    }

    throw new Error(`${name} did not become ready at ${url.toString()} within 60 seconds`);
}

function waitForCouchDb() {
    const url = new URL("_up", integrationEnvironment.hostname);
    const credentials = Buffer.from(`${integrationEnvironment.username}:${integrationEnvironment.password}`).toString(
        "base64"
    );
    return waitForHttpService("CouchDB", url, {
        headers: { Authorization: `Basic ${credentials}` },
    });
}

function waitForMinio() {
    const url = new URL("/minio/health/live", integrationEnvironment.minioEndpoint);
    return waitForHttpService("MinIO", url);
}

function waitForWebDAV() {
    return waitForHttpService("WebDAV", integrationEnvironment.webdavEndpoint, {
        body: `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>`,
        headers: { Depth: "0", "Content-Type": "application/xml; charset=utf-8" },
        method: "PROPFIND",
    });
}

const compose = (...args) => run("docker", ["compose", "--file", composeFile, ...args]);

let failure;
try {
    if (manageServices) {
        await compose("up", "--detach", "couchdb", "minio", "webdav");
        await Promise.all([waitForCouchDb(), waitForMinio(), waitForWebDAV()]);
        await compose("run", "--rm", "minio-init");
    }

    await run(process.execPath, [vitestCli, "run", "--config", "vitest.config.integration.ts"], {
        env: integrationEnvironment,
    });
} catch (error) {
    failure = error;
} finally {
    if (manageServices) {
        try {
            await compose("down", "--volumes", "--remove-orphans");
        } catch (error) {
            failure ??= error;
            if (failure !== error) console.error("Integration service cleanup failed", error);
        }
    }
}

if (failure) throw failure;
