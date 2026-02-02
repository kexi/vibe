> 🇯🇵 [日本語版](./README.ja.md)

# @kexi/vibe-core

Core components for [Vibe CLI](https://github.com/kexi/vibe) - Runtime abstraction, types, errors, and context.

## Overview

This package provides the shared core functionality used by Vibe CLI:

- **Runtime Abstraction**: Cross-platform runtime layer supporting both Deno and Node.js
- **Types**: Configuration schemas and type definitions (using Zod)
- **Errors**: Unified error handling classes
- **Context**: Application context and dependency injection

## Installation

### npm

```bash
npm install @kexi/vibe-core
```

### JSR (Deno)

```typescript
import { runtime, initRuntime } from "jsr:@kexi/vibe-core";
```

## Usage

### Runtime Abstraction

The runtime module provides a unified interface for file system operations, process execution, and environment variables across Deno and Node.js:

```typescript
import { initRuntime, runtime } from "@kexi/vibe-core";

// Initialize runtime at application startup
await initRuntime();

// Use unified runtime APIs
const content = await runtime.fs.readTextFile("./config.json");
const result = await runtime.process.run({ cmd: "git", args: ["status"] });
const home = runtime.env.get("HOME");
```

### Types and Configuration

Parse and validate Vibe configuration files:

```typescript
import { parseVibeConfig, type VibeConfig } from "@kexi/vibe-core";

const config = parseVibeConfig(rawData, "./vibe.toml");
```

### Error Handling

Use typed error classes for consistent error handling:

```typescript
import { GitOperationError, ConfigurationError, WorktreeError } from "@kexi/vibe-core";

throw new GitOperationError("clone", "Repository not found");
throw new ConfigurationError("Invalid hook command", "./vibe.toml");
```

### Context Management

Manage application context with dependency injection:

```typescript
import { createAppContext, setGlobalContext, getGlobalContext } from "@kexi/vibe-core";

// Initialize context at startup
const ctx = createAppContext(runtime);
setGlobalContext(ctx);

// Access context anywhere in the application
const { runtime } = getGlobalContext();
```

## API Reference

### Exports

| Export                            | Description                       |
| --------------------------------- | --------------------------------- |
| `@kexi/vibe-core`                 | Main entry point with all exports |
| `@kexi/vibe-core/runtime`         | Runtime abstraction layer         |
| `@kexi/vibe-core/types`           | Configuration types and schemas   |
| `@kexi/vibe-core/errors`          | Error classes                     |
| `@kexi/vibe-core/context`         | Context management                |
| `@kexi/vibe-core/context/testing` | Testing utilities                 |

### Runtime Detection

```typescript
import { IS_DENO, IS_NODE, IS_BUN, RUNTIME_NAME } from "@kexi/vibe-core";

if (IS_DENO) {
  console.log("Running on Deno");
} else if (IS_NODE) {
  console.log("Running on Node.js");
}
```

## License

Apache-2.0
