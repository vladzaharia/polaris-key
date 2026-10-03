//! S-11: the --mainExe in front of a Godot export. VelopackApp runs first (hooks answered without
//! starting the engine; a downloaded update is applied on startup), then the Godot executable beside
//! the shim is started with the same arguments.
#![windows_subsystem = "windows"]
use std::io::Write;
use std::time::Instant;
use velopack::*;

fn log(t0: &Instant, what: &str) {
    let path = std::env::var("S11_SHIM_LOG").unwrap_or_else(|_| "C:/s11/logs/shim.log".into());
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{{\"t\":\"shim\",\"pid\":{},\"elapsed_ms\":{:.3},\"what\":{:?}}}", std::process::id(), t0.elapsed().as_secs_f64() * 1000.0, what);
    }
}

fn main() {
    let t0 = Instant::now();
    let args: Vec<String> = std::env::args().skip(1).collect();
    log(&t0, &format!("start args={:?} exe={:?}", args, std::env::current_exe().ok()));
    let app = VelopackApp::build();
    #[cfg(target_os = "windows")]
    let app = app
        .on_after_install_fast_callback(|v| log(&t0, &format!("hook install {v}")))
        .on_before_update_fast_callback(|v| log(&t0, &format!("hook obsolete {v}")))
        .on_after_update_fast_callback(|v| log(&t0, &format!("hook updated {v}")))
        .on_before_uninstall_fast_callback(|v| log(&t0, &format!("hook uninstall {v}")));
    app.on_first_run(|v| log(&t0, &format!("firstrun {v}")))
        .on_restarted(|v| log(&t0, &format!("restarted {v}")))
        .run();
    let exe = std::env::current_exe().unwrap();
    let godot = exe.with_file_name("s11game_godot.exe");
    log(&t0, &format!("exec {}", godot.display()));
    let status = std::process::Command::new(&godot).args(&args).status();
    log(&t0, &format!("godot exited {status:?}"));
    std::process::exit(status.ok().and_then(|s| s.code()).unwrap_or(1));
}
