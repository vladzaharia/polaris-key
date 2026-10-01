//! S-05 (e): a tiny launcher in front of a Godot export. It runs VelopackApp first (so Velopack's
//! --veloapp-* hooks are answered in milliseconds, without starting the engine or opening a
//! window), optionally applies an update from a local feed, and then runs the Godot executable
//! that sits beside it, passing every argument through.
//! Env: S05_LOG (log file, default $TMPDIR/s05launcher.log), S05_FEED (a directory or URL feed;
//! when set the launcher checks it, downloads and applies before starting Godot),
//! S05_GODOT_EXE (default: "s05game" beside the launcher).
use std::io::Write;
use std::time::Instant;
use velopack::*;

fn log(t0: &Instant, what: &str) {
    let path = std::env::var("S05_LOG").unwrap_or_else(|_| std::env::temp_dir().join("s05launcher.log").to_string_lossy().into());
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{{\"t\":\"launcher\",\"pid\":{},\"elapsed_ms\":{:.3},\"what\":{:?}}}", std::process::id(), t0.elapsed().as_secs_f64() * 1000.0, what);
    }
}

fn main() {
    let t0 = Instant::now();
    let args: Vec<String> = std::env::args().skip(1).collect();
    log(&t0, &format!("start args={:?}", args));
    let app = VelopackApp::build();
    // The fast-callback registrations exist only on Windows (the only OS whose Update binary runs
    // hooks); run() still recognises --veloapp-* everywhere and exits 0 without starting Godot.
    #[cfg(target_os = "windows")]
    let app = app
        .on_after_install_fast_callback(|v| log(&t0, &format!("hook install {v}")))
        .on_before_update_fast_callback(|v| log(&t0, &format!("hook obsolete {v}")))
        .on_after_update_fast_callback(|v| log(&t0, &format!("hook updated {v}")))
        .on_before_uninstall_fast_callback(|v| log(&t0, &format!("hook uninstall {v}")));
    if args.first().is_some_and(|a| a.starts_with("--veloapp-")) {
        log(&t0, "hook argument seen; VelopackApp::run() will exit 0");
    }
    app.on_first_run(|v| log(&t0, &format!("firstrun {v}")))
        .on_restarted(|v| log(&t0, &format!("restarted {v}")))
        .run();
    // Only reached on a normal start (fast hooks exit the process inside run()).
    if let Ok(feed) = std::env::var("S05_FEED") {
        match UpdateManager::new(sources::FileSource::new(&feed), None, None) {
            Ok(um) => {
                log(&t0, &format!("installed version {} portable={}", um.get_current_version_as_string(), um.get_is_portable()));
                match um.check_for_updates() {
                    Ok(UpdateCheck::UpdateAvailable(info)) => {
                        log(&t0, &format!("update available {}", info.TargetFullRelease.Version));
                        if let Err(e) = um.download_updates(&info, None) {
                            log(&t0, &format!("download error {e:?}"));
                        } else {
                            log(&t0, "downloaded; applying and restarting");
                            if let Err(e) = um.apply_updates_and_restart(&info.TargetFullRelease) {
                                log(&t0, &format!("apply error {e:?}"));
                            }
                            std::process::exit(0);
                        }
                    }
                    Ok(UpdateCheck::NoUpdateAvailable) => log(&t0, "no update available"),
                    Ok(UpdateCheck::RemoteIsEmpty) => log(&t0, "remote feed empty"),
                    Err(e) => log(&t0, &format!("check error {e:?}")),
                }
            }
            Err(e) => log(&t0, &format!("manager error {e:?}")),
        }
    }
    let exe = std::env::current_exe().unwrap();
    let godot = std::env::var("S05_GODOT_EXE").map(std::path::PathBuf::from).unwrap_or_else(|_| exe.with_file_name("s05game"));
    log(&t0, &format!("exec {}", godot.display()));
    let status = std::process::Command::new(&godot).args(&args).status();
    log(&t0, &format!("godot exited {status:?}"));
    std::process::exit(status.ok().and_then(|s| s.code()).unwrap_or(1));
}
