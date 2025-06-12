// import { mixedHash } from "octagonal-wheels/hash/purejs";
// import { type Room, joinRoom } from "trystero";
// import { eventHub } from "../../hub/hub";
import { TrysteroReplicatorP2PServer } from "./TrysteroReplicatorP2PServer";
// import type { BindableObject, ReplicatorHostEnv } from "./types";
// import { createHostingDB } from "./ProxiedDB";

export { TrysteroReplicatorP2PServer as TrysteroConnection };

// export class TrysteroConnection {
//     _env: ReplicatorHostEnv;
//     _server?: TrysteroReplicatorP2PServer;

//     get isServing() {
//         return this._room !== undefined && this._server !== undefined;
//     }

//     constructor(env: ReplicatorHostEnv) {
//         this._env = env;
//         eventHub.onEvent("plugin-unloaded", () => {
//             void this.shutdown();
//         });
//     }

//     get settings() {
//         return this._env.settings;
//     }

//     _room?: Room;

//     get knownAdvertisements() {
//         if (!this._server) return [];
//         if (!this._server.knownAdvertisements) return [];
//         return [...this._server.knownAdvertisements.values()];
//     }

//     getConnection(peerId: string) {
//         if (!this._server) {
//             throw new Error("Server not started");
//         }
//         return this._server.getConnection(peerId);
//     }

// }
