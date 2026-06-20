// Fetris 데스크탑 셸 — 게임 로직은 전부 웹뷰(프론트엔드)에서 동작한다.
// 네이티브 레이어는 창 생성 + LAN 릴레이 서버(USB/Thunderbolt 직결 대전용)를 담당.

mod lan;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(lan::LanState::default())
        .invoke_handler(tauri::generate_handler![
            lan::lan_start,
            lan::lan_stop,
            lan::lan_status,
            lan::lan_discover
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
