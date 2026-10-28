# APK Signature Identity Gate

## Symptom

The local final APK gate checked that v1, v2 and v3 signatures were present, but an APK could pass without checking which certificate signed it.

## Cause

`evaluateVerification` treated an absent expected certificate digest as a match. The shared APK terminal engine also invoked the checker without a keystore, so local and portable builds exercised that fail-open path.

## Fix

APK verification now requires `--keystore` and rejects missing or mismatched signer certificates. The shared terminal engine supplies the repository debug keystore by default; direct workflow invocations keep passing it explicitly.

## Verification

- `node --test scripts/check-apk-signatures.test.mjs scripts/build-apk-engine.test.mjs`: 25 tests passed.
- `node scripts/check-apk-signatures.mjs --self-test`: 8/8 passed.
- Controlled negative: invoking APK verification without `--keystore` exits before resolving `apksigner`.
- Positive artifact check: the final APK passes v1/v2/v3 and matches the repository debug certificate fingerprint.
