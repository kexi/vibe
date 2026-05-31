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
