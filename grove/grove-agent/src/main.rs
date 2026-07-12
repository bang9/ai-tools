//! `grove-agent` — grove's agent launcher and hook relay. See the crate docs (`lib.rs`).

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        // Never returns: it execs the real agent.
        Some("launch") => grove_agent::launch::run(&args[2..]),
        // Never returns: it always exits 0.
        Some("event") => grove_agent::event::run(),
        _ => {
            eprintln!("usage: grove-agent launch <tool> -- <args...>");
            eprintln!("       grove-agent event   (hook JSON on stdin)");
            std::process::exit(2);
        }
    }
}
