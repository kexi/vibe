//! Shell completion generation (fish, zsh) and the shared flag/command SSoT.
//!
//! Ported from `packages/core/src/commands/{completion-spec,fish-completion,
//! zsh-completion}.ts`. The [`spec`] module is the single source of truth; the
//! generators consume it. Output is byte-for-byte identical to the TS, verified
//! against captured snapshots. The clap↔spec consistency check lives in the
//! binary crate's tests (it needs the clap `Cli` definition).

pub mod fish;
pub mod spec;
pub mod zsh;

pub use fish::generate_fish_completion;
pub use spec::{CommandSpec, FlagSpec, PositionalCompletion, GLOBAL_FLAGS, SUBCOMMANDS};
pub use zsh::generate_zsh_completion;
