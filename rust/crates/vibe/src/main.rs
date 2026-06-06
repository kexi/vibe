//! vibe CLI entry point.
//!
//! Parses arguments with clap, reproduces the original `main.ts` dispatch
//! (custom `--version` block, `--verbose`/`--quiet` conflict warning, mutually
//! exclusive flag checks) and routes into `vibe-core`. Commands not yet ported
//! exit with code 1 and a clear message, so the binary builds and runs from
//! Phase 0 while individual commands are filled in over later phases.

mod cli;
mod commands;
mod eval_output;
mod version;

use clap::Parser;
use cli::{Cli, Command};
use vibe_core::commands::Outcome;
use vibe_core::output::OutputOptions;
use vibe_core::{format_error_message, Io, RealIo, VibeError};

fn main() {
    let cli = Cli::parse();

    // Custom version output, matching the TS BUILD_INFO block (stderr, exit 0).
    if cli.version {
        version::print_version();
        std::process::exit(0);
    }

    // Warnings/errors always display regardless of --quiet, as in the TS code.
    let has_conflicting_output = cli.verbose && cli.quiet;
    if has_conflicting_output {
        eprintln!("Warning: Both --verbose and --quiet specified. Using --quiet.");
    }
    let quiet = cli.quiet;
    let opts = OutputOptions::new(cli.verbose, cli.quiet);

    let Some(command) = cli.command else {
        // No subcommand: clap prints help on `--help`; bare invocation shows help.
        print_help();
        std::process::exit(0);
    };

    // The binary owns stderr writes (vibe-core only formats the line). A single
    // RealIo routes both the eval-write-failure and dispatch-failure paths.
    let io = RealIo;

    match dispatch(command, opts) {
        Ok(outcome) => {
            // The SINGLE stdout write point for the eval contract.
            if let Err(error) = eval_output::write_outcome(&outcome) {
                let exit_code = report_error(&io, &error, quiet);
                std::process::exit(exit_code.max(1));
            }
        }
        Err(error) => {
            let exit_code = report_error(&io, &error, quiet);
            if exit_code != 0 {
                std::process::exit(exit_code);
            }
        }
    }
}

/// Format the error via vibe-core and write it to stderr through the injected
/// `Io`, returning the process exit code. Keeps the stderr side-effect in the
/// binary so the formatting stays unit-testable in vibe-core.
fn report_error(io: &impl Io, error: &VibeError, quiet: bool) -> i32 {
    if let Some(message) = format_error_message(error, quiet) {
        io.writeln_stderr(&message);
    }
    error.exit_code()
}

/// Route a parsed subcommand into its handler, returning its [`Outcome`].
fn dispatch(command: Command, opts: OutputOptions) -> Result<Outcome, VibeError> {
    match command {
        Command::Clean(args) => {
            // Mutually exclusive: matches the TS validation in main.ts.
            let has_mutually_exclusive = args.delete_branch && args.keep_branch;
            if has_mutually_exclusive {
                return Err(VibeError::Argument(
                    "--delete-branch and --keep-branch cannot be used together".to_string(),
                ));
            }
            commands::clean(
                args.force,
                args.delete_branch,
                args.keep_branch,
                args.worktree_hook,
                opts,
            )
        }
        Command::Start(args) => commands::start(
            &args.branch_name.unwrap_or_default(),
            args.no_hooks,
            args.no_copy,
            args.dry_run,
            args.base,
            args.track,
            args.worktree_hook,
            opts,
        ),
        Command::Scratch(args) => commands::scratch(
            args.no_hooks,
            args.no_copy,
            args.dry_run,
            args.base,
            args.track,
            opts,
        ),
        Command::Jump(args) => {
            let branch = args.branch_name.unwrap_or_default();
            commands::jump(&branch, opts)
        }
        Command::Rename(args) => {
            let new_name = args.new_name.unwrap_or_default();
            commands::rename(&new_name, args.dry_run, opts)
        }
        Command::Home => commands::home(opts),
        Command::Trust => commands::trust(opts),
        Command::Untrust => commands::untrust(opts),
        Command::Verify => commands::verify(opts),
        Command::Config => commands::config(opts),
        Command::Upgrade(args) => commands::upgrade(args.check, opts),
        Command::ShellSetup(args) => {
            commands::shell_setup(args.shell.as_deref(), args.with_completion, opts)
        }
    }
}

fn print_help() {
    use clap::CommandFactory;
    let mut cmd = Cli::command();
    let _ = cmd.print_help();
    eprintln!();
    eprintln!("{}#readme", version::REPOSITORY);
}
