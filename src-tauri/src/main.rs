// Windows 릴리스에서 콘솔 창이 뜨지 않도록
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    fetris_lib::run()
}
