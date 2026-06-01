---
globs:
  - "flake.nix"
  - "flake.lock"
  - "rust-toolchain.toml"
---

# Tool Version Management

- The development toolchain is defined in `flake.nix` (`devShells.default`) and
  pinned reproducibly by `flake.lock` (a specific `nixpkgs` commit). Update
  versions by editing the package set and running `nix flake update`.
- Rust is the exception: it is managed by `rustup` via `rust-toolchain.toml`,
  which must specify the full patch version (e.g., `1.92.0`) and the cross
  targets the native module builds for.
- The Windows CI fallback (`.github/actions/setup-toolchain`) cannot use Nix;
  its `oven-sh/setup-bun` / `actions/setup-node` / `pnpm/action-setup` versions
  must specify the full patch version (e.g., `1.3.8`). Using `latest` or
  major-only versions is prohibited due to supply chain attack risks.
- When updating versions, verify functionality (`nix develop` + `pnpm run check:all`)
  before committing.

## Fixed-output hashes that track the lockfile

`flake.nix` carries fixed-output hashes that are NOT covered by `flake.lock`
and must be updated by hand whenever the thing they hash changes:

- `pnpmDeps.hash` — the `fetchPnpmDeps` output. **Changes whenever
  `pnpm-lock.yaml` changes** (a dependency add/remove/bump, or a `pnpm install`
  that rewrites integrity digests). Stale here means the `nix-build` job fails
  with `hash mismatch in fixed-output derivation … vibe-pnpm-deps`.
- `pnpmPinned.hash` — only when the pinned pnpm version itself is bumped.
- The four `platforms.*.hash` prebuilt-binary hashes — only on a release that
  republishes those binaries.

To refresh `pnpmDeps.hash` after a lockfile change, build it and copy the
`got:` value Nix reports (OS-independent — same on Linux and macOS):

```sh
nix build '.#fromSource.pnpmDeps' --rebuild   # prints specified: / got:
```

Then paste the `got:` `sha256-…` into `flake.nix` and confirm `nix flake check`
passes. Because the `nix-build` job runs only on its `paths` filter
(`pnpm-lock.yaml`, `flake.nix`, …) and is easy to miss on merge, **always run
this check locally in any PR that touches `pnpm-lock.yaml`.**
