//! Core library for the vibe git worktree CLI.
//!
//! This crate holds the implementation that the `vibe` binary dispatches into:
//! git/worktree operations, config & settings, trust verification, copy
//! strategies and hooks. It is a straight port of `packages/core/src` from the
//! original TypeScript implementation; the binary crate (`vibe`) owns argument
//! parsing (clap) and process exit, keeping this crate free of CLI concerns so
//! it stays unit-testable.

pub mod ansi;
pub mod atomic;
pub mod clock;
pub mod commands;
pub mod completion;
pub mod config;
pub mod config_loader;
pub mod config_path;
pub mod copy;
pub mod copy_runner;
pub mod error;
pub mod fast_remove;
pub mod fuzzy;
pub mod git;
pub mod glob;
pub mod hash;
pub mod hooks;
pub mod http;
pub mod io;
pub mod mru;
pub mod output;
pub mod progress;
pub mod prompt;
pub mod repo_info;
pub mod settings;
pub mod settings_io;
pub mod shell;
pub mod stdin;
pub mod timestamp;
pub mod upgrade_meta;
pub mod worktree_ops;
pub mod worktree_path;
pub mod worktree_rename;
pub mod worktree_validator;

pub use commands::{Outcome, StartCommand, UnimplementedStart};
pub use error::{format_error_message, Result, Severity, VibeError};
pub use io::{Io, RealIo};
