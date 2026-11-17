mod claude;
mod hook;
mod repl;
mod session;

use std::io::Read;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::process::exit;

use hook::{Agent, HookOutcome};
use session::Session;

fn agent_arg(args: &[String]) -> Option<Agent> {
    match args.iter().position(|a| a == "--agent").and_then(|i| args.get(i + 1)).map(String::as_str) {
        Some("claude") => Some(Agent::Claude),
        _ => None,
    }
}

fn stdin_text() -> String {
    let mut s = String::new();
    let _ = std::io::stdin().read_to_string(&mut s);
    s
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("check") => {
            let session = match Session::from_env() {
                Ok(s) => s,
                Err(reason) => {
                    eprintln!("{reason}");
                    exit(2);
                }
            };
            if session.is_some() {
                // Deny before Claude Code's 10 s hook timeout, which would let the tool run.
                std::thread::spawn(|| {
                    std::thread::sleep(std::time::Duration::from_secs(8));
                    eprintln!("pangu check took too long");
                    exit(2);
                });
            }
            let outcome = catch_unwind(AssertUnwindSafe(|| match agent_arg(&args) {
                Some(agent) => hook::check(agent, &stdin_text(), session.as_ref(), |s| {
                    session::policy_context(&session::open_store()?, s)
                }),
                None if session.is_some() => HookOutcome::Deny("pangu check: unknown agent".into()),
                None => HookOutcome::Silent,
            }));
            match outcome {
                Ok(HookOutcome::Silent) => {}
                Ok(HookOutcome::Deny(reason)) => {
                    eprintln!("{reason}");
                    exit(2);
                }
                // A panic inside a session denies; outside one it must stay inert.
                Err(_) if session.is_some() => {
                    eprintln!("pangu check failed");
                    exit(2);
                }
                Err(_) => {}
            }
        }
        Some("record") => {
            if let (Some(agent), Some(s)) = (agent_arg(&args), Session::from_env().ok().flatten()) {
                let _ = catch_unwind(AssertUnwindSafe(|| hook::record(agent, &stdin_text(), &s)));
            }
        }
        Some("claude") => exit(claude::run(&args[1..])),
        Some("allow") => {
            let Some(command) = args.get(1) else {
                eprintln!("usage: pangu allow \"<command>\"");
                exit(2);
            };
            let root = Session::from_env()
                .ok()
                .flatten()
                .map(|s| s.root)
                .unwrap_or_else(|| session::find_root(&std::env::current_dir().unwrap_or_default()));
            match session::open_store().and_then(|st| session::remember_command(&st, &root, command)) {
                Ok(()) => println!("Always allowed in {}: {command}", root.display()),
                Err(e) => {
                    eprintln!("pangu allow failed: {e}");
                    exit(1);
                }
            }
        }
        _ => exit(repl::run(&args)),
    }
}
