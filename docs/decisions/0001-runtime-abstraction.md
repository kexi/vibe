# ADR-0001: Runtime Abstraction Layer

## Status

Accepted

## Context

Vibe CLI needs to run on multiple JavaScript runtimes (Deno, Node.js, Bun). Each runtime has different APIs for:
- File system operations
- Process spawning
- Environment variables
- Platform detection
- I/O operations

We needed a way to write runtime-agnostic code while maintaining type safety and performance.

## Decision

We introduced a runtime abstraction layer (`src/runtime/`) that:

1. **Defines a common `Runtime` interface** with standardized APIs for:
   - `RuntimeFS`: File system operations (readFile, writeTextFile, mkdir, etc.)
   - `RuntimeProcess`: Process spawning and execution
   - `RuntimeEnv`: Environment variable access
   - `RuntimeBuild`: Platform and architecture detection
   - `RuntimeControl`: Process control (exit, cwd, etc.)
   - `RuntimeIO`: Standard I/O streams
   - `RuntimeErrors`: Error type detection
   - `RuntimeSignals`: Signal handling

2. **Implements runtime-specific adapters**:
   - `src/runtime/deno/`: Deno-specific implementation
   - `npm/src/runtime/node/`: Node.js-specific implementation (in npm package)
   - `npm/src/runtime/bun/`: Bun-specific implementation (in npm package)

3. **Uses dependency injection via `AppContext`**:
   - All functions receive context as parameter (with sensible defaults)
   - Enables easy testing with mock contexts
   - Avoids runtime detection at call sites

## Consequences

### Positive

- **Portability**: Same codebase runs on Deno, Node.js, and Bun
- **Testability**: Easy to mock runtime APIs for unit testing
- **Type safety**: Strong typing for all runtime operations
- **Single source of truth**: Core logic written once, adapters handle differences

### Negative

- **Abstraction overhead**: Additional layer adds some complexity
- **Feature parity**: Must ensure all runtimes support required features
- **Maintenance burden**: Changes to common interfaces require updates to all adapters

### Neutral

- Runtime detection happens once at startup, not at each call site
- Some runtime-specific optimizations may not be exposed through common interface
