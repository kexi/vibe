# CI/CD Workflow Rules

## Glob Pattern

`**/.github/workflows/*.yml`

## Tool Setup Requirements

When creating or modifying GitHub Actions workflows, **always consider using mise** to set up development tools instead of individual setup actions.

### Decision Process

Before adding a setup action, check:
1. Is the tool supported by mise? (See [mise registry](https://mise.jdx.dev/registry.html))
2. If yes, add it to `.mise.toml` and use `jdx/mise-action@v2`
3. If no, use the individual setup action as a fallback

### Mise-Supported Tools (Use mise instead)

| Individual Action | Use mise instead |
|-------------------|------------------|
| `actions/setup-node` | ✅ Yes |
| `actions/setup-python` | ✅ Yes |
| `actions/setup-go` | ✅ Yes |
| `actions/setup-java` | ✅ Yes |
| `ruby/setup-ruby` | ✅ Yes |
| `denoland/setup-deno` | ✅ Yes |
| `oven-sh/setup-bun` | ✅ Yes |
| `dtolnay/rust-toolchain` | ✅ Yes |
| `pnpm/action-setup` | ✅ Yes |
| `hashicorp/setup-terraform` | ✅ Yes |
| `azure/setup-kubectl` | ✅ Yes |
| `azure/setup-helm` | ✅ Yes |

### Example

```yaml
# Good - using mise
steps:
  - uses: actions/checkout@v4
  - uses: jdx/mise-action@v2
    env:
      MISE_HTTP_TIMEOUT: "120"
  - run: pnpm install

# Bad - using individual setup actions
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version: 22
  - uses: pnpm/action-setup@v4
    with:
      version: 10
  - run: pnpm install
```

### Exceptions (Cannot use mise)

Some actions are not replaceable by mise:
- `actions/checkout` - Git checkout, not a tool
- `actions/cache` - Caching mechanism
- `actions/upload-artifact` / `actions/download-artifact` - Artifact handling
- `docker/build-push-action` - Docker-specific operations
- Platform-specific SDK setup (e.g., Xcode, Android SDK)

### Benefits

1. **Single source of truth**: Tool versions are defined in `.mise.toml`
2. **Consistency**: Same versions used locally and in CI
3. **Simpler workflows**: One action instead of multiple
4. **Automatic updates**: Renovate/Dependabot updates `.mise.toml` centrally
5. **Faster CI**: mise caches tools efficiently

### Adding New Tools

When you need a new tool in CI:

1. Check if mise supports it: `mise plugins ls-remote | grep <tool>`
2. Add to `.mise.toml`:
   ```toml
   [tools]
   <tool> = "<version>"
   ```
3. Use `jdx/mise-action@v2` in the workflow (it reads `.mise.toml` automatically)

### Reference

See `.mise.toml` for currently defined tool versions in this project.
