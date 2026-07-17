# Standard input and output

Commonlib defines a narrow `StandardIo` contract for command-line hosts. The contract covers standard input, line-oriented prompting, standard output, and standard error. It does not own process arguments, exit codes, signals, logging levels, or log persistence.

## Host composition

The host chooses and constructs the implementation, then places it on its host-specific Context or passes it to the command composition which owns it. The base `ServiceContext` does not require standard I/O because Obsidian, browser, and headless service compositions do not all have terminal streams.

```ts
import type { StandardIo } from '@vrtmrz/livesync-commonlib/context';
import { createNodeStandardIo } from '@vrtmrz/livesync-commonlib/node';

class CliContext {
    constructor(readonly standardIo: StandardIo) {}
}

const context = new CliContext(createNodeStandardIo());
```

`createNodeStandardIo()` binds to `process.stdin`, `process.stdout`, and `process.stderr` by default. An embedding host may supply alternative Node streams. The host remains responsible for those streams and their lifecycle.

## Output contract

`writeStdout()` and `writeStderr()` accept text or `Uint8Array` chunks and do not add a newline. Commands must add delimiters required by their own text protocol. Binary command output must use `writeStdout()` directly without conversion through a logger.

Diagnostic logging remains a separate capability. A host can render selected logs to standard error, but Commonlib does not make a Logger part of `StandardIo` and does not interpret log levels in this adapter.

## Tests and embedded hosts

Consumers can inject a small memory implementation without replacing process globals:

```ts
import type { StandardIo, StandardIoChunk } from '@vrtmrz/livesync-commonlib/context';

const stdout: StandardIoChunk[] = [];
const io: StandardIo = {
    readStdin: async () => 'input',
    prompt: async () => 'answer',
    writeStdout: (chunk) => stdout.push(chunk),
    writeStderr: () => undefined,
};
```

This boundary lets a command test assert exact protocol bytes, prompts, and errors while the real Node adapter is verified separately against injected streams.
