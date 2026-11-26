/// <reference lib="webworker" />

import { serveBackgroundWorker } from "./serveBackgroundWorker.ts";

serveBackgroundWorker(self);
