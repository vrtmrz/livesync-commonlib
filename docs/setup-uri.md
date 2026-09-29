# Setup URI sharing

The focused `@vrtmrz/livesync-commonlib/setup-uri` entry encodes and decodes
encrypted Setup URIs. A Setup URI carries settings and remote credentials;
share its URI and passphrase separately.

`encodeTimeBoundSetupURI` offers two generation modes. `ephemeral` is the
default. It binds the URI to the current seven-day UTC window, anchored at the
Unix epoch, and returns the exclusive end of that window as `usableUntil` in
Unix milliseconds. This is a fixed window, so a newly generated URI may have
less than seven days remaining. Show the returned instant in the user's time
zone when presenting the URI.

`persistent` returns `usableUntil: null` and delegates to the original
`encodeSettingsToSetupURI` algorithm with the entered passphrase. A reader
which already supports that original encryption format can open it. Both modes
have the same URI structure and carry no visible mode or timestamp field.

```ts
import {
    encodeTimeBoundSetupURI,
    decodeSettingsFromSetupURI,
    getTimeBoundSetupURIUsableUntil,
    isTimeBoundSetupURIUsableNow,
} from '@vrtmrz/livesync-commonlib/setup-uri';

const endShownBeforeGeneration = getTimeBoundSetupURIUsableUntil();
const generated = await encodeTimeBoundSetupURI(settings, enteredPassphrase, {
    mode: 'ephemeral',
    removeProperties: ['pluginSyncExtendedSetting'],
    skipDefaultValue: true,
});

const importedSettings = await decodeSettingsFromSetupURI(generated.uri.trim(), enteredPassphrase);
const canStillCopy = isTimeBoundSetupURIUsableNow(generated.usableUntil);
const endWasAccurate = generated.usableUntil === endShownBeforeGeneration;
```

The decoder automatically tries the current Ephemeral window and the entered
passphrase. Previous and future windows are not searched. Existing Setup URIs
remain readable. An Ephemeral URI cannot be opened through the unchanged old
decoder with the entered passphrase.

The receiving device supplies the clock. Someone who knows the passphrase
can reproduce historical time factors or alter that clock. Opening a URI does
not revoke credentials already imported, and Ephemeral does not mean one-time
use. An unsuccessful opening attempt cannot reliably distinguish an incorrect
passphrase, damaged ciphertext, or a different time window.

The encoder checks that its Ephemeral window has not changed during encryption.
`getTimeBoundSetupURIUsableUntil` lets a host show the exact end before a user
selects the mode. Compare that value with the generated `usableUntil` and
present the new end if the window changed during selection. A host may also use
`isTimeBoundSetupURIUsableNow` before showing or copying an open result; it
checks both edges of the selected window, including a clock moved backwards to
an earlier window. An already open copy dialogue can otherwise retain a URI
after its window ends, but the reader will reject that URI. The selected export
mode is an interaction choice; it is not a synchronised Vault setting.
