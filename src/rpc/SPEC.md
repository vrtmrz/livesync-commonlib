# RPC Module — Specification

Version: 1.0  
Status: Draft

---

## 1. Scope

This document specifies the behaviour that any correct implementation of the
`rpc` module MUST, SHOULD, or MAY exhibit. It is intended as the normative
reference if the module is extracted into a standalone package.

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHOULD", "RECOMMENDED",
"MAY", and "OPTIONAL" follow RFC 2119.

---

## 2. Definitions

| Term             | Meaning                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| **Room**         | A logical endpoint that owns one `TransportAdapter` and zero or more registered method handlers. |
| **Peer**         | Any remote party identified by an opaque `peerId: string`.                                       |
| **Session**      | A helper bound to a specific `peerId`, used to issue calls.                                      |
| **Invocation**   | One call to a remote method, identified by a unique `requestId`.                                 |
| **Envelope**     | The JSON-serialisable object passed through the wire protocol.                                   |
| **Wire message** | The physical unit sent through the transport (`RpcWireMessage`).                                 |

---

## 3. Transport Contract

### 3.1 `TransportAdapter` interface

A conforming transport MUST implement:

```
send(message: RpcWireMessage, peerId: string): void | Promise<void>
onMessage(handler: (message: RpcWireMessage, peerId: string) => void): () => void
```

A conforming transport SHOULD implement:

```
onPeerJoin?(handler: (peerId: string) => void): () => void
onPeerLeave?(handler: (peerId: string) => void): () => void
```

**[T-1]** `send` MUST deliver the message to the peer identified by `peerId`
without modification.

**[T-2]** The `onMessage` callback MUST be invoked exactly once per received
wire message. The returned function, when called, MUST stop further
invocations.

**[T-3]** The library MUST NOT assume any ordering guarantee from the transport.
Messages MAY arrive out of order or be duplicated. The chunking layer handles
re-ordering and deduplication at the stream level.

**[T-4]** The transport MAY be unreliable (UDP-style). The chunking mechanism
provides retransmission for multi-chunk streams; single-frame `"raw"` messages
are sent exactly once and are not retransmitted by the library.

---

## 4. Protocol

### 4.1 Versioning

**[P-1]** On first contact with a peer (i.e., when `onPeerJoin` fires), a Room
MUST send a `handshake` envelope:

```json
{ "kind": "handshake", "versionMajor": 1, "versionMinor": 0 }
```

**[P-2]** Rooms MUST accept messages from peers whose `versionMajor` is
identical to their own.

**[P-3]** Rooms SHOULD reject (log and discard) envelopes from peers with a
different `versionMajor`. Rooms SHOULD tolerate peers with a lower
`versionMinor`.

### 4.2 Request / Response

**[P-4]** A caller MUST generate a globally unique `requestId` for every
invocation. The format is implementation-defined; the reference implementation
uses `"req-<timestamp36>-<random>"`.

**[P-5]** A caller MUST register the `requestId` in its pending-invocation map
before sending the request envelope, and remove it on settlement (resolve or
reject).

**[P-6]** The callee MUST send exactly one response envelope for each received
request, either `{ ok: true, data }` or `{ ok: false, error }`.

**[P-7]** If the callee's handler throws, the Room MUST catch the error, convert
it to `RpcErrorShape` via `asRpcErrorShape`, and send it as `{ ok: false,
error }`. The handler's exception MUST NOT propagate unhandled.

**[P-8]** If the caller does not receive a response within `timeoutMs`
milliseconds, it MUST reject the pending invocation with `RpcError("TIMEOUT")`
and remove the `requestId` from its pending map.

### 4.3 Cancellation

**[P-9]** A caller MAY send a `cancel` envelope to notify the callee that the
result is no longer needed. The callee SHOULD check for cancellation before
performing expensive operations (via the `InboundCallContext`).

**[P-10]** The callee MUST NOT send a response after receiving a `cancel` for the
same `requestId`.

**[P-11]** Sending a `cancel` does NOT remove the caller's pending invocation.
The invocation settles only when the callee's response arrives or the timeout
fires.

### 4.4 Chunking

**[P-12]** Before sending, a Room MUST calculate the UTF-8 byte length of the
serialised envelope. If it exceeds `maxWirePayloadBytes`, the Room MUST split
the envelope using `splitIntoChunks` and send one `"chunk"` wire message per
segment.

**[P-13]** Each `"chunk"` message MUST carry a unique `streamId`, a zero-based
`index`, the `total` number of chunks, and the chunk `payload`.

**[P-14]** The receiver MUST buffer incoming chunks by `streamId`. Once all
`total` chunks for a stream have arrived, the receiver MUST reassemble them in
index order and process the resulting payload as a single envelope.

**[P-15]** After receiving at least one chunk for a stream, the receiver MUST
schedule a timer (`chunkMissingRetryMs`). When the timer fires and the stream
is still incomplete, the receiver MUST send a `"chunk-ack"` message listing the
missing indices.

**[P-16]** The original sender, on receiving a `"chunk-ack"` with non-empty
`missing`, MUST retransmit only the listed chunk indices.

**[P-17]** On stream completion, the receiver SHOULD send a `"chunk-ack"` with an
empty `missing` array to signal the sender that the stream is done.

---

## 5. Method Registration

**[M-1]** A method name MUST contain at least one `.` or `/` character. Rooms
MUST throw `RpcError("PROTOCOL_ERROR")` when a flat (unnested) name is
registered or invoked.

**[M-2]** Method names are case-sensitive strings. The namespace portion (before
the first `.` or `/`) is the domain of the registering subsystem.

**[M-3]** Registering a method that is already registered MUST silently overwrite
the previous handler.

**[M-4]** When `serial: true` is passed to `register`, the Room MUST ensure that
concurrent invocations of that method are serialised: the next invocation MUST
NOT start until the previous one has settled.

**[M-5]** Method handlers receive `(peerId: string, ...args: JsonLike[])` and
MUST return a `JsonLike`-serialisable value or throw.

---

## 6. Error Codes

| Code             | Numeric analogue | Semantics                                   |
| ---------------- | ---------------- | ------------------------------------------- |
| `TIMEOUT`        | 408              | Remote did not reply within the deadline.   |
| `NOT_CONNECTED`  | 503              | No transport connection to the target peer. |
| `REMOTE_ERROR`   | 500              | Remote handler threw an exception.          |
| `CANCELLED`      | 499              | Caller cancelled the in-flight request.     |
| `PROTOCOL_ERROR` | 400              | Malformed method name, bad version, etc.    |

**[E-1]** `RpcError` MUST be an `instanceof Error` so that `catch` blocks that
check `instanceof Error` are satisfied.

**[E-2]** `RpcError.details` MAY carry a `JsonLike` value. The PouchDB extension
uses this field to convey `{ status, name, reason }` across the transport.

---

## 7. PouchDB Extension Specification

### 7.1 `exposeDB`

**[PDB-1]** `exposeDB(room, db, ns?)` MUST register the following methods under
the given namespace prefix (default `"pdb"`):

`<ns>.info`, `<ns>.id`, `<ns>.changes`, `<ns>.get`, `<ns>.put`,
`<ns>.bulkGet`, `<ns>.bulkDocs`, `<ns>.revsDiff`, `<ns>.allDocs`

**[PDB-2]** `<ns>.changes` MUST always force `live: false` regardless of what the
caller passes. Live push feeds are not supported.

**[PDB-3]** Any exception thrown by a PouchDB operation that carries a `status`
property (HTTP status code) or a `name` property (CouchDB error name) MUST be
wrapped in `RpcError("REMOTE_ERROR")` with `details: { status?, name?,
reason? }`.

**[PDB-4]** Exceptions that carry neither `status` nor `name` MUST be re-thrown
unchanged. They are serialised by `asRpcErrorShape` without PouchDB-specific
details.

### 7.2 `RpcPouchDBProxy`

**[PDB-5]** `RpcPouchDBProxy` MUST extend `EventEmitter` so that `pouchdb-
replication` can call `.once("destroyed", …)` on the proxy object.

**[PDB-6]** The object returned by `proxy.changes(opts)` MUST be simultaneously:

- An `EventEmitter` with `"change"`, `"complete"`, and `"error"` events.
- A thenable (`then` / `catch`) resolving to the full changes response.
- Cancellable via a `cancel()` method that sets an internal `cancelled` flag.

**[PDB-7]** After `cancel()` is called:

- The `"complete"` event MUST NOT be emitted.
- The loop over `results` MUST be aborted at the next iteration boundary.
- All listeners MUST be removed.

**[PDB-8]** When the remote call for `changes` fails, the proxy MUST emit an
`"error"` event on the changes feed object and MUST NOT emit `"complete"`.

**[PDB-9]** When `callDB` receives an `RpcError("REMOTE_ERROR")` whose `details`
carries a PouchDB error shape (`details.name` or `details.status`), it MUST
reconstruct a plain `Error` with those properties attached (`err.status`,
`err.name`, `err.reason`) and throw that instead of the `RpcError`.

**[PDB-10]** `RpcPouchDBProxy.activeTasks` MUST be a stub object whose `add`,
`get`, `update`, `remove`, and `list` methods are no-ops. This satisfies the
interface required by `pouchdb-replication`.

---

## 8. Constraints and Limitations

| Constraint                  | Value / Note                                                  |
| --------------------------- | ------------------------------------------------------------- |
| Serialisation format        | JSON only. Binary blobs must be Base64-encoded by the caller. |
| Maximum in-flight requests  | Unbounded (limited only by memory).                           |
| Live changes feeds          | Not supported by the PouchDB extension.                       |
| Multi-peer broadcast        | Not supported; each invocation targets one peer.              |
| Ordered delivery            | Not assumed; chunking handles reassembly.                     |
| Encryption / authentication | Out of scope; the transport layer is responsible.             |

---

## 9. Versioning Policy

Versions follow **SemVer**.

- A `versionMajor` bump indicates a breaking change to the wire protocol
  (envelope shapes, handshake semantics, etc.).
- A `versionMinor` bump indicates backwards-compatible additions (new envelope
  types, optional fields, etc.).
- Patch version bumps are library-internal changes with no wire-protocol
  impact.
