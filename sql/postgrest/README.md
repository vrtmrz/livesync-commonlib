# Adaptive Journal through PostgREST

This experimental provider stores Adaptive Journal data in PostgreSQL through a narrow PostgREST RPC contract. It does not expose tables, implement Opaque Journal object operations, or act as a CouchDB replication endpoint.

Apply `adaptive_journal_v1.sql` as the database owner, expose only the `livesync_api` schema through PostgREST, and retain `livesync_private` as a non-exposed schema. The SQL contract supports generic PostgREST and the Supabase Data API.

Provision a Vault from a trusted SQL administration session:

```sql
select * from livesync_private.provision_adaptive_vault();
```

The function returns a random Vault ID and high-entropy Vault credential once. PostgreSQL stores only its SHA-256 verifier. Give both values to the Vault owner through an appropriate secret channel. To revoke the credential and delete that Vault's remote data, run:

```sql
select livesync_private.revoke_adaptive_vault('<vault-id>');
```

The client connection contains:

- the PostgREST or Supabase Data API endpoint;
- the exposed schema name, normally `livesync_api`;
- the Vault ID and Vault credential;
- an optional Supabase publishable API key; and
- the host's custom-request-handler choice.

Do not put a Supabase secret key, `service_role` JWT, or database credential in a client profile. The adapter rejects recognised privileged Supabase keys. The Vault credential authorises every Adaptive Journal operation for one Vault, so protect it like the synchronisation passphrase. Client-side encryption protects record content, but it does not conceal row counts, sizes, timing, the Vault ID, or the repository ID from the server.

## Physical model

The database contains one immutable Manifest per provisioned Vault, content-addressed Chunk rows, immutable Writer descriptors, and immutable Commit Bundle rows. A Commit Bundle contains the exact Metadata and Commit frames. There is no separately visible Metadata staging row, Pack Catalogue, Catalogue Delta, or Opaque object table.

`livesync_adaptive_chunks` accepts HAS, GET, and PUT binary batches. The implementation parses each bounded batch once, preserves input order, and uses set-based queries for lookup and immutable insertion. During publication, the client checks every required key in one HAS batch and sends only missing frames in one or more PUT batches with a preferred request size of 32 MiB. It bisects a PUT further if a hosting gateway returns HTTP 413. Partial Chunk insertion is safe because the immutable Commit is the visibility boundary. For reads, the function preflights the encoded response size and returns HTTP 413 rather than constructing a multi-entry response above the preferred 32 MiB size; the client then bisects the requested key set. One larger Chunk may use the 64 MiB wire ceiling. A successful PUT or Commit response is authoritative; the client performs verification reads only after an ambiguous transport or server failure.

`livesync_adaptive_commit_create` serialises one Writer stream, checks its predecessor, verifies that every required Chunk is visible, and inserts the Commit Bundle in one transaction. Readers list visible Writers and Commit sequences, then fetch one exact bundle for both the Commit and Metadata frames.

Remote format changes use `livesync_adaptive_reset`; there is no in-place data-format migration. The Vault credential remains valid after a reset. Use the private revocation helper when the credential itself must stop working.
