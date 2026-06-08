# `rpc` — Generic Peer-to-Peer RPC Library

(Yet to be named properly — suggestions welcome!)

A transport-agnostic, type-safe RPC library for structured method calls between
isolated JavaScript environments (browser tabs, Worker threads, WebRTC peers,
WebSocket connections, etc.).

---

## Table of Contents

- [`rpc` — Generic Peer-to-Peer RPC Library](#rpc--generic-peer-to-peer-rpc-library)
  - [Table of Contents](#table-of-contents)
  - [Overview](#overview)
  - [Architecture](#architecture)
  - [Core API](#core-api)
    - [`TransportAdapter`](#transportadapter)
    - [`RpcRoom`](#rpcroom)
    - [`RpcSession`](#rpcsession)
    - [`RpcError`](#rpcerror)
  - [Wire Protocol](#wire-protocol)
    - [Envelope types](#envelope-types)
    - [Versioning](#versioning)
    - [Chunking](#chunking)
  - [PouchDB Extension](#pouchdb-extension)
    - [`exposeDB`](#exposedb)
    - [`RpcPouchDBProxy`](#rpcpouchdbproxy)
  - [Usage Examples](#usage-examples)
    - [Minimal in-process pair (unit tests / iframe)](#minimal-in-process-pair-unit-tests--iframe)
    - [Trystero (WebRTC / Nostr)](#trystero-webrtc--nostr)
      - [Low-level: `wrapTrysteroRoom` + `joinTrysteroRoom`](#low-level-wraptrysteroroom--jointrysteroroom)
      - [High-level: `serveTrysteroDB` / `connectTrysteroDBClient`](#high-level-servetrysterodb--connecttrysterodbclient)
    - [PouchDB replication over an in-process transport](#pouchdb-replication-over-an-in-process-transport)
  - [Design Decisions](#design-decisions)
    - [Why did not you use a similar package?](#why-did-not-you-use-a-similar-package)
    - [Why `TransportAdapter` instead of a built-in transport?](#why-transportadapter-instead-of-a-built-in-transport)
    - [Why does `RpcPouchDBProxy` extend `EventEmitter`?](#why-does-rpcpouchdbproxy-extend-eventemitter)
    - [Why is the changes feed always one-shot?](#why-is-the-changes-feed-always-one-shot)
    - [Why require namespaced method names?](#why-require-namespaced-method-names)
    - [Chunking retransmission strategy](#chunking-retransmission-strategy)

---

## Overview

The `rpc` module lets you call named methods on a remote peer as if they were
local `async` functions. All serialisation, chunking of large payloads, error
propagation, and in-flight request tracking are handled automatically.

Note that this module was originally implemented as a hotch-potch on Self-hosted
LiveSync.

Key properties:

- **Transport-agnostic**: any bidirectional channel that can send opaque byte
  strings satisfies the `TransportAdapter` interface.
- **Namespaced methods**: every registered method must contain a `.` or `/` so
  that methods from different subsystems cannot collide (`pdb.get`, `sync/push`,
  etc.).
- **Automatic chunking**: payloads larger than `maxWirePayloadBytes` (default 32
  KiB) are split into chunks and reassembled, with a retransmission mechanism
  for missing chunks.
- **PouchDB extension**: the optional `pouchdb/` sub-module exposes a PouchDB
  database over RPC and provides a proxy object that looks like a `PouchDB`
  instance, allowing `PouchDB.replicate()` to work transparently across the
  transport.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                     Your application                  │
│                                                      │
│   exposeDB(room, db)          new RpcPouchDBProxy()  │
│   room.register("ns.method") ──► session.call()      │
└────────────────┬─────────────────────────┬───────────┘
                 │ RpcRoom                 │ RpcRoom
                 │  ┌────────────────────┐ │
                 │  │  RpcSession        │ │
                 │  │  (per peer)        │ │
                 └──┤                    ├─┘
                    │  request/response  │
                    │  chunking / ACK    │
                    └────────┬───────────┘
                             │ TransportAdapter
                    ┌────────┴───────────┐
                    │  WebRTC / WS / BroadcastChannel / MockTransport …  │
                    └────────────────────┘
```

Both sides share the same `RpcRoom` class. A `Room` can simultaneously act as a
_server_ (registering handlers) and a _client_ (calling remote methods via
`RpcSession`).

---

## Core API

### `TransportAdapter`

The only interface your integration layer must implement. As an at a glance; it
has been based on the Trystero architecture.

```ts
interface TransportAdapter {
    /** Send a wire message to the given peer. */
    send(message: RpcWireMessage, peerId: string): void | Promise<void>;

    /** Register a listener for incoming messages. Returns an unsubscribe fn. */
    onMessage(
        handler: (message: RpcWireMessage, peerId: string) => void,
    ): () => void;

    /** Optional: called when a new peer connects. */
    onPeerJoin?(handler: (peerId: string) => void): () => void;

    /** Optional: called when a peer disconnects. */
    onPeerLeave?(handler: (peerId: string) => void): () => void;
}
```

`RpcWireMessage` is a discriminated union of three shapes:

| `wire` value  | Purpose                                             |
| ------------- | --------------------------------------------------- |
| `"raw"`       | Complete JSON envelope (fits within size limit)     |
| `"chunk"`     | One chunk of a split large payload                  |
| `"chunk-ack"` | Acknowledgement / retransmission request for chunks |

The actual transport layer only needs to deliver these as opaque objects (or
their JSON representations). Ordering is not required; all chunk streams are
identified by a unique `streamId`.

---

### `RpcRoom`

The central hub for one peer. A single `RpcRoom` instance manages:

- all outgoing calls to remote peers
- all incoming method invocations
- chunking / reassembly of large payloads
- protocol handshake on peer join

```ts
const room = new RpcRoom({ transport: myTransport });
```

**Constructor options** (`RpcRoomOptions`):

| Option                | Type               | Default  | Description                              |
| --------------------- | ------------------ | -------- | ---------------------------------------- |
| `transport`           | `TransportAdapter` | required | The underlying message channel           |
| `maxWirePayloadBytes` | `number`           | `32768`  | Maximum single wire-message size (bytes) |
| `chunkMissingRetryMs` | `number`           | `350`    | Delay before requesting missing chunks   |

**Key methods**:

```ts
// Register a handler for a namespaced method.
// The method name must contain "." or "/".
room.register(
    "ns.method",
    async (peerId, ...args) => {
        return result; // must be JsonLike-serialisable
    },
    { serial: false },
);
```

> `serial: true` causes invocations of this method to be queued — only one
> concurrent call per method is processed at a time.

```ts
// Invoke a method on a specific peer (low-level).
const result = await room.invoke(peerId, "ns.method", [arg1, arg2], timeoutMs);
```

```ts
// Close the room: unsubscribes transport, rejects all pending calls.
room.close();
```

```ts
// Get or create a typed session for a peer.
const session = room.session(peerId);
```

---

### `RpcSession`

A thin wrapper around `RpcRoom.invoke()` bound to a specific `peerId`.

```ts
const session = room.session("peer-b");

// Typed call — T is the expected return type.
const info = await session.call<{ db_name: string }>("pdb.info");

// Namespace proxy — generates a method for each property access.
const db = session.createProxy<MyDbApi>("db");
await db.put(doc); // calls "db.put" on the remote peer
```

---

### `RpcError`

All RPC-layer errors are instances of `RpcError` and have a `code` property:

| Code             | When thrown                                            |
| ---------------- | ------------------------------------------------------ |
| `TIMEOUT`        | Remote did not respond within `timeoutMs`              |
| `NOT_CONNECTED`  | Attempted to call when no peer is connected            |
| `REMOTE_ERROR`   | Remote handler threw; details carried in `err.details` |
| `CANCELLED`      | Call was cancelled before completion                   |
| `PROTOCOL_ERROR` | Malformed method name, version mismatch, etc.          |

```ts
import { RpcError } from "./rpc";

try {
    await session.call("ns.method", []);
} catch (err) {
    if (err instanceof RpcError) {
        console.error(err.code, err.message, err.details);
    }
}
```

---

## Wire Protocol

All messages are JSON-serialised `RpcEnvelope` values, carried inside an
`RpcWireMessage` wrapper that adds chunking metadata.

### Envelope types

```
Request:   { kind:"request",  requestId, method, args }
Response:  { kind:"response", requestId, ok:true,  data }
           { kind:"response", requestId, ok:false, error: {code, message, details} }
Cancel:    { kind:"cancel",   requestId }
Handshake: { kind:"handshake", versionMajor, versionMinor }
```

### Versioning

On peer join, each side sends a `handshake` envelope with `versionMajor` /
`versionMinor` (`1.0` currently). Future breaking changes will increment
`versionMajor`; additive changes increment `versionMinor`. The handshake values
are stored in `room.peerVersion` for optional feature negotiation.

### Chunking

When a serialised envelope exceeds `maxWirePayloadBytes`:

1. It is split into `N` chunks using UTF-8–aware byte counting.
2. Each chunk is sent as `{ wire:"chunk", streamId, index, total, payload }`.
3. The receiver schedules a `chunkMissingRetryMs` timer. If the stream is
   incomplete when the timer fires, it sends
   `{ wire:"chunk-ack", streamId,
missing:[…] }` listing absent indices.
4. The sender retransmits only the missing chunks.
5. Once all chunks arrive, the receiver reassembles them and processes the
   envelope normally.

---

## PouchDB Extension

Located in `pouchdb/`. Enables transparent PouchDB replication between two
environments that share an `RpcRoom` transport.

### `exposeDB`

Call this on the _server_ side to make a local PouchDB database accessible over
RPC.

```ts
import { exposeDB } from "./rpc/pouchdb/RpcPouchDBServer";

exposeDB(room, db); // default namespace "pdb"
exposeDB(room, db, "mydb"); // custom namespace
```

Registered methods (with default namespace `pdb`):

| Method         | PouchDB call             | Notes                                |
| -------------- | ------------------------ | ------------------------------------ |
| `pdb.info`     | `db.info()`              |                                      |
| `pdb.id`       | `db.id()`                |                                      |
| `pdb.changes`  | `db.changes(opts)`       | Always one-shot (`live:false`)       |
| `pdb.get`      | `db.get(id, opts)`       |                                      |
| `pdb.put`      | `db.put(doc, opts)`      |                                      |
| `pdb.bulkGet`  | `db.bulkGet(opts)`       |                                      |
| `pdb.bulkDocs` | `db.bulkDocs(req, opts)` | Accepts array or `{docs, new_edits}` |
| `pdb.revsDiff` | `db.revsDiff(diff)`      |                                      |
| `pdb.allDocs`  | `db.allDocs(opts)`       |                                      |

**Error propagation**: PouchDB errors carry `status`, `name`, and optionally
`reason` properties. The `runDB` wrapper inside `RpcPouchDBServer` serialises
these into `RpcError.details` so `RpcPouchDBProxy` can reconstruct the full
error shape on the client side. Generic non-PouchDB errors are re-thrown without
modification.

### `RpcPouchDBProxy`

Call this on the _client_ side. It presents the same public interface as a
`PouchDB` instance and can be passed directly to `PouchDB.replicate()`,
`PouchDB.sync()`, or the `replicateShim` utility.

```ts
import { RpcPouchDBProxy } from "./rpc/pouchdb/RpcPouchDBProxy";

const proxy = new RpcPouchDBProxy(session, "remote-db-name");

// Use with PouchDB.replicate():
await PouchDB.replicate(proxy, localDb, { live: false });
await PouchDB.replicate(localDb, proxy, { live: false });

// Use with replicateShim:
await replicateShim(localDb, proxy, onProgress);
```

**`changes()` return value**

`proxy.changes(opts)` returns an object that is simultaneously:

- An **EventEmitter** (`.on("change" | "complete" | "error", …)`, `.cancel()`) —
  satisfying the interface required by `pouchdb-replication`.
- A **thenable** (`.then()` / `.catch()` / `await`) — satisfying the interface
  used by `replicateShim`.

> Live feeds (`live: true`) are not supported. The remote side always serves a
> one-shot snapshot. Callers that need live replication should run repeated
> one-shot cycles.

---

## Usage Examples

### Minimal in-process pair (unit tests / iframe)

```ts
import { RpcRoom } from "./rpc";
import type { RpcWireMessage, TransportAdapter } from "./rpc";

class InProcessTransport implements TransportAdapter {
    peer?: InProcessTransport;
    private handler?: (msg: RpcWireMessage, from: string) => void;
    constructor(public readonly peerId: string) {}

    send(msg: RpcWireMessage) {
        this.peer?.handler?.(msg, this.peerId);
    }
    onMessage(h: (msg: RpcWireMessage, from: string) => void) {
        this.handler = h;
        return () => {
            this.handler = undefined;
        };
    }
}

const tA = new InProcessTransport("a");
const tB = new InProcessTransport("b");
tA.peer = tB;
tB.peer = tA;

const roomA = new RpcRoom({ transport: tA });
const roomB = new RpcRoom({ transport: tB });

roomA.register(
    "math.add",
    async (_peer, x, y) => (x as number) + (y as number),
);

const result = await roomB.session("a").call<number>("math.add", [3, 4]);
// result === 7

roomA.close();
roomB.close();
```

### Trystero (WebRTC / Nostr)

[Trystero](https://github.com/dmotz/trystero) is a serverless P2P library that
establishes WebRTC data channels via a signalling back-end (Nostr, MQTT, etc.).
The helpers in `transports/TrysteroTransport.ts` wrap a Trystero room as a
`TransportAdapter` and provide high-level server / client convenience functions.

Connection settings follow the **Self-hosted LiveSync** `sls+p2p://` URL scheme
(parseable by `ConnectionStringParser`) or can be passed as a
`P2PConnectionInfo` object directly.

#### Low-level: `wrapTrysteroRoom` + `joinTrysteroRoom`

Use these when you need direct access to the `RpcRoom` for custom method
registration.

```ts
import {
    joinTrysteroRoom,
    wrapTrysteroRoom,
} from "./rpc/transports/TrysteroTransport";
import { RpcRoom } from "./rpc";

// From a P2PConnectionInfo object:
const handle = joinTrysteroRoom({
    P2P_Enabled: true,
    P2P_roomID: "my-room",
    P2P_passphrase: "shared-secret",
    P2P_relays: "wss://relay.example.com",
    P2P_AppID: "my-app",
    P2P_AutoStart: false,
    P2P_AutoBroadcast: false,
    P2P_turnServers: "",
    P2P_turnUsername: "",
    P2P_turnCredential: "",
});
// handle.peerId  — this peer's Trystero selfId
// handle.transport — TransportAdapter ready for RpcRoom
// handle.leave() — leaves the Trystero room

const rpcRoom = new RpcRoom({ transport: handle.transport });

// Register handlers (server):
rpcRoom.register("db.ping", async (_peerId) => "pong");

// Call a remote method (client) after the peer appears via onPeerJoin:
const result = await rpcRoom.session(serverPeerId).call<string>("db.ping");
console.log(result); // "pong"

rpcRoom.close();
await handle.leave();
```

From a `sls+p2p://` connection string (Self-hosted LiveSync URL scheme):

```ts
import { joinTrysteroRoomFromUrl } from "./rpc/transports/TrysteroTransport";

const handle = joinTrysteroRoomFromUrl(
    "sls+p2p://my-room?relays=wss%3A%2F%2Frelay.example.com&appId=my-app",
);
```

#### High-level: `serveTrysteroDB` / `connectTrysteroDBClient`

These pair `joinTrysteroRoom` + `exposeDB` / `RpcPouchDBProxy` into single
calls.

**Server peer** — joins the room and exposes a PouchDB database:

```ts
import { serveTrysteroDB } from "./rpc/transports/TrysteroTransport";

const db = new PouchDB("server-db");
const server = serveTrysteroDB(settings, db);

console.log("server peer ID:", server.peerId);
// Share server.peerId with the client out-of-band
// (advertisement, QR code, configuration, etc.).

// When done:
await server.close();
```

**Client peer** — joins the same room and replicates from the server:

```ts
import { connectTrysteroDBClient } from "./rpc/transports/TrysteroTransport";
import PouchDB from "pouchdb-core";
import replication from "pouchdb-replication";

PouchDB.plugin(replication);

// serverPeerId was obtained from the server out-of-band.
const client = connectTrysteroDBClient(settings, serverPeerId, "server-db");

const localDb = new PouchDB("local-db");

// One-shot pull via native PouchDB.replicate:
await PouchDB.replicate(client.proxy, localDb, { live: false });

// Or incremental pull with checkpoints via replicateShim:
import { replicateShim } from "../pouchdb/ReplicatorShim";
await replicateShim(
    localDb,
    client.proxy as any,
    (docs) => Promise.resolve(console.log(`wrote ${docs.length} docs`)),
);

await client.close();
```

> **Note on peer discovery**: Trystero assigns `selfId` automatically; neither
> side knows the other's ID before joining. You must share the server's `peerId`
> out-of-band (e.g. via the LiveSync advertisement mechanism, a separate relay
> message, or static configuration).

### PouchDB replication over an in-process transport

```ts
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import replication from "pouchdb-replication";
import { exposeDB, RpcPouchDBProxy, RpcRoom } from "./rpc";

PouchDB.plugin(MemoryAdapter);
PouchDB.plugin(replication);

// … set up roomA / roomB as above …

const serverDb = new PouchDB("server", { adapter: "memory" });
await serverDb.put({ _id: "hello", value: "world" });

exposeDB(roomA, serverDb); // server side

const localDb = new PouchDB("local", { adapter: "memory" });
const proxy = new RpcPouchDBProxy(roomB.session("a"), "server");

await PouchDB.replicate(proxy, localDb, { live: false });

const doc = await localDb.get("hello");
console.log(doc.value); // "world"
```

---

## Design Decisions

### Why did not you use a similar package?

The package name is a bit misleading, as it doesn't really have a rich RPC
functionality. However, despite that, many RPC libraries need some treatment to
be used in a P2P context. Hence, this library has been designed to be
transport-agnostic and to be familiar to them, as like Trystero.

In other words, this is a meta-RPC library, an RPC wrapper, or, an 'RPC over
RPC'. Well, now you are the godfather (really). Waiting for your contributions!

### Why `TransportAdapter` instead of a built-in transport?

The RPC core is intentionally transport-free. WebRTC data channels, WebSocket
connections, `BroadcastChannel`, Electron `ipcRenderer`, and in-process message
queues all have different lifecycle and delivery semantics. Keeping them out of
the core lets the library be embedded in any environment without pulling in
transitive dependencies.

### Why does `RpcPouchDBProxy` extend `EventEmitter`?

`pouchdb-replication` calls `.once("destroyed", …)` on the _database_ object,
not just on the changes feed. Extending `EventEmitter` satisfies that contract
without needing a separate shim layer.

### Why is the changes feed always one-shot?

A live push channel would require the server side to maintain a long-lived
subscription per client and push `change` events asynchronously. This is
feasible but significantly more complex. For the current use-case
(checkpoint-based replication), repeated one-shot polls are equivalent and much
simpler to reason about.

### Why require namespaced method names?

Flat method names (`"get"`, `"put"`) are too easy to accidentally shadow across
subsystems. Requiring a `.` or `/` acts as a cheap lint rule that forces callers
to declare their ownership domain upfront.

### Chunking retransmission strategy

The current strategy (timer-based NACK after `chunkMissingRetryMs`) is optimised
for local/LAN transports where loss is rare. For high-loss networks a proper
selective-repeat ARQ with sequence numbers would be more appropriate. The design
is intentionally simple to match the expected deployment context. And, mostly we
are on some kind of reliable transport (WebRTC... yes, Trystero)! that does its
own error correction on underlying transport, so we may never need a more
complex strategy.
