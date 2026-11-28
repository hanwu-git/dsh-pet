#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--mcp") {
        dsh_pet_lib::run_mcp_stdio();
        return;
    }
    if args.iter().any(|a| a == "--hook") {
        dsh_pet_lib::run_hook_cli(&args);
        return;
    }
    dsh_pet_lib::run();
}
