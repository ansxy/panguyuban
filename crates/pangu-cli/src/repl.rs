//! `pangu` with no subcommand: Panguyuban's own agent loop in the terminal.

use std::io::{BufRead, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use agent_runtime::{
    hooks_named, tools_named, Approval, Approver, Conversation, Harness, RunCommand, StopReason, Task, TaskEvent, Tool,
};
use provider_openai::{provider_key, saved_providers, OpenAiCompat, SavedProvider};

use crate::session::{self, Session};

pub struct Choice {
    pub provider: SavedProvider,
    pub model: String,
}

pub fn choose(
    providers: &[SavedProvider],
    saved: Option<(String, String)>,
    flag_provider: Option<&str>,
    flag_model: Option<&str>,
) -> Result<Choice, String> {
    if providers.is_empty() {
        return Err("No provider saved. Add one in Panguyuban → Settings → Providers, or run `pangu claude`.".into());
    }
    let saved_provider = saved.as_ref().and_then(|(id, _)| providers.iter().find(|p| &p.id == id));
    let provider = match flag_provider {
        Some(f) => providers
            .iter()
            .find(|p| p.id == f || p.name.eq_ignore_ascii_case(f))
            .ok_or_else(|| format!("No provider named \"{f}\" is saved."))?,
        None => match saved_provider {
            Some(p) => p,
            None if providers.len() == 1 => &providers[0],
            None => return Err("Several providers saved; pick one: pangu --provider <name> --model <id>".into()),
        },
    };
    // A saved model belongs to the saved provider only.
    let saved_model = saved.as_ref().filter(|(id, _)| *id == provider.id).map(|(_, m)| m.as_str());
    match flag_model.or(saved_model) {
        Some(m) => Ok(Choice { provider: provider.clone(), model: m.to_string() }),
        None => Err("Pick a model: pangu --model <id>".into()),
    }
}

fn skill_body(raw: &str) -> &str {
    match raw.strip_prefix("---").and_then(|r| r.split_once("\n---")) {
        Some((_, body)) => body.trim(),
        None => raw.trim(),
    }
}

pub const WORK_ON_PROJECT: &str = include_str!("../../../skills/product/work-on-project/SKILL.md");
// ponytail: add a line here when a skill lands under skills/engineering/
pub const ENGINEERING: &[(&str, &str)] =
    &[("endpoint-requests", include_str!("../../../skills/engineering/endpoint-requests/SKILL.md"))];

pub fn system_prompt(root: &Path, tools: &[String]) -> String {
    let mut out = skill_body(WORK_ON_PROJECT).to_string();
    for (_, s) in ENGINEERING {
        out.push_str("\n\n");
        out.push_str(skill_body(s));
    }
    out.push_str(&format!(
        "\n\n## How this session runs\n\nYou work in the folder {}. Your tools: {}. Use them to read, search and change files there. \
         Commands you run with run_command ask the user first, so keep them few and say what each is for. \
         Never touch the .git folder; it is off limits.\n",
        root.display(),
        tools.join(", ")
    ));
    out
}

static CANCEL: AtomicBool = AtomicBool::new(false);

/// First Ctrl-C cancels the turn (and a running command); a second one quits. Atomics and `_exit` only.
extern "C" fn on_sigint(_: libc::c_int) {
    if CANCEL.swap(true, Ordering::SeqCst) {
        unsafe { libc::_exit(130) };
    }
}

struct TtyApprover;

impl Approver for TtyApprover {
    fn approve(&self, command: &str) -> Approval {
        eprintln!("  ▶ wants to run: {command}  [y] allow  [a] always here  [n] deny");
        let mut line = String::new();
        let read = std::fs::File::open("/dev/tty").map(std::io::BufReader::new).and_then(|mut r| r.read_line(&mut line));
        // ponytail: the read restarts after Ctrl-C, so the deny lands on Enter (or a second Ctrl-C quits).
        if read.is_err() || CANCEL.load(Ordering::SeqCst) {
            return Approval::Deny;
        }
        match line.trim().chars().next() {
            Some('y' | 'Y') => Approval::Once,
            Some('a' | 'A') => Approval::AlwaysHere,
            _ => Approval::Deny,
        }
    }
}

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).map(String::as_str)
}

fn setup(args: &[String]) -> Result<(Session, Choice, Harness, Task), String> {
    let store = session::open_store()?;
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let session = Session::start(session::find_root(&cwd));
    let ctx = session::policy_context(&store, &session)?;
    let saved = store
        .get_app_data("pangu")
        .ok()
        .flatten()
        .and_then(|j| serde_json::from_str::<serde_json::Value>(&j).ok())
        .and_then(|v| Some((v["provider"].as_str()?.to_string(), v["model"].as_str()?.to_string())));
    let choice = choose(&saved_providers(&store)?, saved, flag(args, "--provider"), flag(args, "--model"))?;
    let eff = ctx.effective;
    let mut tools: Vec<Box<dyn Tool>> =
        tools_named(&eff.tools.iter().filter(|t| *t != "run_command").cloned().collect::<Vec<_>>());
    if eff.tools.iter().any(|t| t == "run_command") {
        let root = session.root.clone();
        let remember = move |cmd: &str| {
            if let Err(e) = session::open_store().and_then(|st| session::remember_command(&st, &root, cmd)) {
                eprintln!("Could not remember \"{cmd}\" for this folder: {e}");
            }
        };
        tools.push(Box::new(RunCommand::new(
            Box::new(TtyApprover),
            ctx.always_allowed,
            Box::new(remember),
            Duration::from_secs(600),
            &CANCEL,
        )));
    }
    let chat = OpenAiCompat { base_url: choice.provider.base_url.clone(), api_key: provider_key(&choice.provider.id)? };
    let harness = Harness { chat: Box::new(chat), tools, hooks: hooks_named(&eff.hooks) };
    let task = Task {
        system: system_prompt(&session.root, &eff.tools),
        prompt: String::new(),
        model: Some(choice.model.clone()),
        work_dir: session.root.clone(),
        write_paths: vec!["*".into()],
        max_steps: eff.max_steps,
        timeout: eff.timeout,
        record: Some(session.record_path()),
    };
    Ok((session, choice, harness, task))
}

fn show(event: TaskEvent) {
    match event {
        TaskEvent::Step { summary, ok, .. } => println!("  {} {summary}", if ok { "✓" } else { "✗" }),
        TaskEvent::Message { text } => text.lines().for_each(|l| println!("  {l}")),
    }
}

pub fn run(args: &[String]) -> i32 {
    let (session, choice, harness, mut task) = match setup(args) {
        Ok(x) => x,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    // Ctrl-C cancels the running turn and kills a running command; a second Ctrl-C quits.
    unsafe { libc::signal(libc::SIGINT, on_sigint as extern "C" fn(libc::c_int) as libc::sighandler_t) };
    println!("Panguyuban agent · {} · {} · {}", choice.provider.name, choice.model, session.root.display());
    let mut conversation = Conversation::new();
    let mut saved = false;
    let stdin = std::io::stdin();
    loop {
        print!("> ");
        let _ = std::io::stdout().flush();
        let mut line = String::new();
        match stdin.lock().read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let line = line.trim();
        if line == "exit" {
            break;
        }
        if line.is_empty() {
            continue;
        }
        task.prompt = line.to_string();
        CANCEL.store(false, Ordering::SeqCst);
        match harness.run_turn(&task, &mut conversation, &CANCEL, &show) {
            Ok(out) => {
                match out.stopped {
                    Some(StopReason::MaxSteps) => println!("Stopped: step limit reached"),
                    Some(StopReason::TimedOut) => println!("Stopped: time limit reached"),
                    Some(StopReason::Cancelled) => println!("Stopped: cancelled"),
                    None => println!("{}", out.message),
                }
                if !saved && out.stopped.is_none() {
                    let v = serde_json::json!({"provider": choice.provider.id, "model": choice.model});
                    match session::open_store().and_then(|st| st.set_app_data("pangu", &v.to_string()).map_err(|e| e.to_string())) {
                        Ok(()) => saved = true,
                        Err(e) => eprintln!("Could not remember this provider and model: {e}"),
                    }
                }
            }
            Err(e) => eprintln!("{e}"),
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(id: &str, name: &str) -> SavedProvider {
        SavedProvider { id: id.into(), name: name.into(), base_url: "http://localhost:1".into() }
    }

    #[test]
    fn flags_win() {
        let ps = [p("a", "Local"), p("b", "Router")];
        let c = choose(&ps, Some(("a".into(), "m1".into())), Some("router"), Some("qwen")).unwrap();
        assert_eq!((c.provider.id.as_str(), c.model.as_str()), ("b", "qwen"));
    }

    #[test]
    fn the_saved_choice_is_reused() {
        let ps = [p("x", "Local"), p("y", "Router")];
        let c = choose(&ps, Some(("x".into(), "m1".into())), None, None).unwrap();
        assert_eq!((c.provider.id.as_str(), c.model.as_str()), ("x", "m1"));
        let err = choose(&ps, Some(("gone".into(), "m1".into())), None, None).err().unwrap();
        assert!(err.starts_with("Several providers saved"));
    }

    #[test]
    fn one_provider_still_needs_a_model() {
        assert_eq!(choose(&[p("a", "Local")], None, None, None).err().unwrap(), "Pick a model: pangu --model <id>");
        assert_eq!(choose(&[p("a", "Local")], None, None, Some("m")).unwrap().model, "m");
    }

    #[test]
    fn no_provider_points_to_settings() {
        let e = choose(&[], None, None, None).err().unwrap();
        assert!(e.contains("Settings → Providers") && e.contains("pangu claude"));
    }

    #[test]
    fn the_prompt_names_the_folder_and_rules() {
        let tools: Vec<String> = ["read_file", "run_command"].map(String::from).into();
        let s = system_prompt(Path::new("/tmp/orders-api"), &tools);
        assert!(s.contains("read_file, run_command") && s.contains("ask the user first"));
        assert!(s.contains("/tmp/orders-api") && s.contains(".git") && s.contains("## How this session runs"));
        assert!(!s.contains("---\nname:"));
    }

    #[test]
    fn every_engineering_skill_is_compiled_in() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../skills/engineering");
        let mut on_disk: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .filter(|e| e.path().join("SKILL.md").is_file())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        on_disk.sort();
        let mut listed: Vec<&str> = ENGINEERING.iter().map(|(n, _)| *n).collect();
        listed.sort();
        assert_eq!(on_disk, listed);
    }
}
