insert into livesync_private.adaptive_vaults (vault_id, credential_digest)
values (
    'integration-vault-01',
    livesync_private.sha256(convert_to('integration-vault-credential-0000000000001', 'UTF8'))
)
on conflict (vault_id) do update set credential_digest = excluded.credential_digest;

insert into livesync_private.adaptive_vaults (vault_id, credential_digest)
values (
    'integration-vault-02',
    livesync_private.sha256(convert_to('integration-vault-credential-0000000000002', 'UTF8'))
)
on conflict (vault_id) do update set credential_digest = excluded.credential_digest;
