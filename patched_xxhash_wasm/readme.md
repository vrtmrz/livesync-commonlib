# Patched xxhash_wasm
This is the patched [xxhash-wasm](https://github.com/jungomi/xxhash-wasm) module.

To avoid the parsing error, All BigInt literals (e.g., `64n`) have been rewritten as BigInt(x) (e.g., `BigInt(64)`). I could not reproduce the same binary from the repo., So just modified the bundled module.

The bundle has been made from v1.0.2 which has been npm installed.