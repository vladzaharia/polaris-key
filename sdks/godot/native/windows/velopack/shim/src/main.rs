//! The Velopack `--mainExe` in front of a Godot Windows export (P5-07; S-05 §4.5, notes/S-11 §4.2).
//!
//! Velopack starts the main exe for each `--veloapp-*` hook and kills it if it lingers (15-30 s).
//! This shim answers the hooks in milliseconds without starting the engine (the measured 9-15 ms
//! against 455-487 ms for Godot itself), applies an update Update.exe left pending, and otherwise
//! starts `<own stem>_godot.exe` beside itself with the same arguments, waits for it and exits with
//! its exit code. `pack_velopack.ps1` copies this binary in as `<Game>.exe` beside
//! `<Game>_godot.exe`.
//!
//! In a DEBUG build, `PKEY_SHIM_LOG=<file>` appends one line per step; a release build carries no
//! logging at all.
#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(debug_assertions)]
use std::io::Write;
use std::path::PathBuf;
use std::time::Instant;
use velopack::*;

/// One line to `PKEY_SHIM_LOG`. Compiled into debug builds only: a release shim writes nothing and
/// reads no logging variable.
#[cfg(debug_assertions)]
fn log(t0: &Instant, what: &str) {
    if let Some(path) = std::env::var_os("PKEY_SHIM_LOG") {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(
                f,
                "{{\"src\":\"shim\",\"pid\":{},\"ms\":{:.3},\"what\":{:?}}}",
                std::process::id(),
                t0.elapsed().as_secs_f64() * 1000.0,
                what
            );
        }
    }
}

#[cfg(not(debug_assertions))]
fn log(_t0: &Instant, _what: &str) {}

/// `<dir>/<stem>_godot.exe` (Windows) or `<dir>/<stem>_godot` beside this executable.
fn godot_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let stem = exe.file_stem()?.to_string_lossy().to_string();
    let name = if cfg!(windows) { format!("{stem}_godot.exe") } else { format!("{stem}_godot") };
    Some(exe.with_file_name(name))
}

fn main() {
    let t0 = Instant::now();
    // OS strings: a non-UTF-8 argument (a path on Windows) reaches Godot as given.
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    log(&t0, &format!("start {args:?}"));
    let app = VelopackApp::build();
    #[cfg(windows)]
    let app = app
        .on_after_install_fast_callback(|v| log(&t0, &format!("hook install {v}")))
        .on_before_update_fast_callback(|v| log(&t0, &format!("hook obsolete {v}")))
        .on_after_update_fast_callback(|v| log(&t0, &format!("hook updated {v}")))
        .on_before_uninstall_fast_callback(|v| log(&t0, &format!("hook uninstall {v}")));
    app.on_first_run(|v| log(&t0, &format!("first run {v}")))
        .on_restarted(|v| log(&t0, &format!("restarted {v}")))
        .run();
    let Some(godot) = godot_path() else {
        log(&t0, "cannot locate the executable");
        std::process::exit(1);
    };
    log(&t0, &format!("exec {}", godot.display()));
    match std::process::Command::new(&godot).args(&args).status() {
        Ok(status) => {
            log(&t0, &format!("godot exited {status:?}"));
            std::process::exit(status.code().unwrap_or(1));
        }
        Err(e) => {
            log(&t0, &format!("could not start {}: {e}", godot.display()));
            std::process::exit(1);
        }
    }
}
