// Fetris 데스크탑 셸 — 게임 로직은 전부 웹뷰(프론트엔드)에서 동작한다.
// 네이티브 레이어는 창 생성만 담당 (Electron 대비 가벼운 네이티브 WebView).

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
