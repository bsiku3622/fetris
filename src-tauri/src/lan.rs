// ============================================================================
// LAN 릴레이 — 데스크탑(Tauri) 전용 내장 WebSocket 릴레이 서버.
// backend/src/server.ts 의 릴레이 로직을 Rust로 포팅한 것으로, 동일한
// create/join/relay/relay-to 프로토콜을 말한다. 따라서 프론트의 NetClient가
// 호스트(ws://127.0.0.1:PORT)와 게스트(ws://<호스트IP>:PORT) 양쪽에서
// 코드 변경 없이 그대로 붙는다. 비행기처럼 인터넷이 없는 환경에서
// USB/Thunderbolt 브리지로 묶인 두 노트북이 직접 대전하기 위한 것.
// 서버는 게임 메시지(msg)를 해석하지 않고 그대로 중계한다(sender-authoritative).
// ============================================================================

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::Message;

const DEFAULT_PORT: u16 = 47474;
const DISCOVERY_PORT: u16 = 47475; // UDP 비콘 포트(호스트 자동 탐색)
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN: usize = 4;

// ---- 프로토콜 (backend/src/protocol.ts 와 동일) ----------------------------

#[derive(Deserialize)]
#[serde(tag = "t")]
enum ClientControl {
    #[serde(rename = "create")]
    Create {
        #[serde(rename = "maxPlayers")]
        max_players: Option<u32>,
        nick: Option<String>,
    },
    #[serde(rename = "join")]
    Join {
        code: Option<String>,
        nick: Option<String>,
    },
    #[serde(rename = "leave")]
    Leave,
    #[serde(rename = "relay")]
    Relay { msg: Value },
    #[serde(rename = "relay-to")]
    RelayTo {
        #[serde(rename = "targetId")]
        target_id: String,
        msg: Value,
    },
}

#[derive(Serialize, Clone)]
struct PlayerInfo {
    id: String,
    #[serde(rename = "isHost")]
    is_host: bool,
    nick: String,
}

#[derive(Serialize)]
#[serde(tag = "t")]
enum ServerControl {
    #[serde(rename = "created")]
    Created {
        code: String,
        #[serde(rename = "myId")]
        my_id: String,
    },
    #[serde(rename = "joined")]
    Joined {
        code: String,
        #[serde(rename = "myId")]
        my_id: String,
        players: Vec<PlayerInfo>,
    },
    #[serde(rename = "peer-joined")]
    PeerJoined { player: PlayerInfo },
    #[serde(rename = "peer-left")]
    PeerLeft {
        #[serde(rename = "playerId")]
        player_id: String,
    },
    #[serde(rename = "error")]
    Error { reason: String },
    #[serde(rename = "relay")]
    Relay { from: String, msg: Value },
}

// ---- 방/허브 상태 ----------------------------------------------------------

struct Player {
    conn_id: u64,
    id: String,
    is_host: bool,
    nick: String,
}

struct Room {
    players: Vec<Player>,
    max_players: usize,
}

struct Inner {
    rooms: HashMap<String, Room>,                       // code -> room
    conns: HashMap<u64, mpsc::UnboundedSender<Message>>, // conn_id -> 아웃바운드 채널
    conn_room: HashMap<u64, String>,                    // conn_id -> room code (sockToPlayer)
    rng: u64,
    pid_counter: u64,
}

type Hub = Arc<Mutex<Inner>>;

static CONN_SEQ: AtomicU64 = AtomicU64::new(1);

fn sanitize_nick(n: Option<String>) -> String {
    let s = n.unwrap_or_default();
    let t: String = s.trim().chars().take(16).collect();
    if t.is_empty() {
        "Player".to_string()
    } else {
        t
    }
}

impl Inner {
    fn new() -> Self {
        let seed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x9e3779b97f4a7c15)
            | 1;
        Inner {
            rooms: HashMap::new(),
            conns: HashMap::new(),
            conn_room: HashMap::new(),
            rng: seed,
            pid_counter: 0,
        }
    }

    fn next_rng(&mut self) -> u64 {
        // xorshift64
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.rng = x;
        x
    }

    fn gen_code(&mut self) -> String {
        for _ in 0..1000 {
            let mut code = String::with_capacity(CODE_LEN);
            for _ in 0..CODE_LEN {
                let r = (self.next_rng() % CODE_ALPHABET.len() as u64) as usize;
                code.push(CODE_ALPHABET[r] as char);
            }
            if !self.rooms.contains_key(&code) {
                return code;
            }
        }
        // 극히 드문 충돌 폴백
        format!("R{}", self.next_rng() % 100000)
    }

    fn gen_player_id(&mut self) -> String {
        self.pid_counter += 1;
        let n = self.pid_counter;
        let r = self.next_rng() & 0xffff;
        format!("p{n:x}{r:x}")
    }

    fn send(&self, conn_id: u64, msg: &ServerControl) {
        if let Some(tx) = self.conns.get(&conn_id) {
            if let Ok(s) = serde_json::to_string(msg) {
                let _ = tx.send(Message::Text(s.into()));
            }
        }
    }

    fn broadcast(&self, code: &str, msg: &ServerControl, exclude: Option<u64>) {
        let json = match serde_json::to_string(msg) {
            Ok(s) => s,
            Err(_) => return,
        };
        if let Some(room) = self.rooms.get(code) {
            for p in &room.players {
                if Some(p.conn_id) == exclude {
                    continue;
                }
                if let Some(tx) = self.conns.get(&p.conn_id) {
                    let _ = tx.send(Message::Text(json.clone().into()));
                }
            }
        }
    }

    fn player_id_of(&self, conn_id: u64, code: &str) -> Option<String> {
        self.rooms
            .get(code)
            .and_then(|r| r.players.iter().find(|p| p.conn_id == conn_id))
            .map(|p| p.id.clone())
    }

    fn handle(&mut self, conn_id: u64, raw: ClientControl) {
        match raw {
            ClientControl::Create { max_players, nick } => {
                if self.conn_room.contains_key(&conn_id) {
                    self.teardown(conn_id);
                }
                let code = self.gen_code();
                let max = (max_players.unwrap_or(4).clamp(2, 8)) as usize;
                let pid = self.gen_player_id();
                let player = Player {
                    conn_id,
                    id: pid.clone(),
                    is_host: true,
                    nick: sanitize_nick(nick),
                };
                self.rooms.insert(
                    code.clone(),
                    Room {
                        players: vec![player],
                        max_players: max,
                    },
                );
                self.conn_room.insert(conn_id, code.clone());
                self.send(conn_id, &ServerControl::Created { code, my_id: pid });
            }
            ClientControl::Join { code, nick } => {
                let code = code.unwrap_or_default().to_uppercase();
                match self.rooms.get(&code) {
                    None => {
                        self.send(
                            conn_id,
                            &ServerControl::Error {
                                reason: "room-not-found".into(),
                            },
                        );
                        return;
                    }
                    Some(r) if r.players.len() >= r.max_players => {
                        self.send(
                            conn_id,
                            &ServerControl::Error {
                                reason: "room-full".into(),
                            },
                        );
                        return;
                    }
                    _ => {}
                }
                if self.conn_room.contains_key(&conn_id) {
                    self.teardown(conn_id);
                }
                let pid = self.gen_player_id();
                let player = Player {
                    conn_id,
                    id: pid.clone(),
                    is_host: false,
                    nick: sanitize_nick(nick),
                };
                let pinfo = PlayerInfo {
                    id: player.id.clone(),
                    is_host: player.is_host,
                    nick: player.nick.clone(),
                };
                let existing: Vec<PlayerInfo> = self
                    .rooms
                    .get(&code)
                    .map(|r| {
                        r.players
                            .iter()
                            .map(|p| PlayerInfo {
                                id: p.id.clone(),
                                is_host: p.is_host,
                                nick: p.nick.clone(),
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                if let Some(room) = self.rooms.get_mut(&code) {
                    room.players.push(player);
                }
                self.conn_room.insert(conn_id, code.clone());
                self.send(
                    conn_id,
                    &ServerControl::Joined {
                        code: code.clone(),
                        my_id: pid,
                        players: existing,
                    },
                );
                self.broadcast(
                    &code,
                    &ServerControl::PeerJoined { player: pinfo },
                    Some(conn_id),
                );
            }
            ClientControl::Relay { msg } => {
                if let Some(code) = self.conn_room.get(&conn_id).cloned() {
                    if let Some(from) = self.player_id_of(conn_id, &code) {
                        self.broadcast(
                            &code,
                            &ServerControl::Relay { from, msg },
                            Some(conn_id),
                        );
                    }
                }
            }
            ClientControl::RelayTo { target_id, msg } => {
                if let Some(code) = self.conn_room.get(&conn_id).cloned() {
                    if let Some(from) = self.player_id_of(conn_id, &code) {
                        let target = self
                            .rooms
                            .get(&code)
                            .and_then(|r| r.players.iter().find(|p| p.id == target_id))
                            .map(|p| p.conn_id);
                        if let Some(tcid) = target {
                            self.send(tcid, &ServerControl::Relay { from, msg });
                        }
                    }
                }
            }
            ClientControl::Leave => self.teardown(conn_id),
        }
    }

    fn teardown(&mut self, conn_id: u64) {
        let code = match self.conn_room.remove(&conn_id) {
            Some(c) => c,
            None => return,
        };
        let mut remove_room = false;
        let mut left_id: Option<String> = None;
        if let Some(room) = self.rooms.get_mut(&code) {
            if let Some(pos) = room.players.iter().position(|p| p.conn_id == conn_id) {
                let was_host = room.players[pos].is_host;
                left_id = Some(room.players[pos].id.clone());
                room.players.remove(pos);
                if room.players.is_empty() {
                    remove_room = true;
                } else if was_host {
                    room.players[0].is_host = true; // 호스트 승계
                }
            }
        }
        if remove_room {
            self.rooms.remove(&code);
        } else if let Some(pid) = left_id {
            self.broadcast(&code, &ServerControl::PeerLeft { player_id: pid }, None);
        }
    }
}

// ---- 비동기 서버 태스크 ----------------------------------------------------

async fn handle_conn(stream: TcpStream, hub: Hub, mut sd_rx: watch::Receiver<bool>) {
    let ws = match tokio_tungstenite::accept_async(stream).await {
        Ok(w) => w,
        Err(_) => return,
    };
    let (mut sink, mut rstream) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let conn_id = CONN_SEQ.fetch_add(1, Ordering::Relaxed);
    {
        let mut g = hub.lock().unwrap();
        g.conns.insert(conn_id, tx);
    }

    // 아웃바운드 writer
    let writer = tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            if sink.send(m).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    // 인바운드 reader
    loop {
        tokio::select! {
            msg = rstream.next() => {
                match msg {
                    Some(Ok(m)) => {
                        if m.is_close() { break; }
                        if let Ok(s) = m.to_text() {
                            if !s.is_empty() {
                                if let Ok(ctrl) = serde_json::from_str::<ClientControl>(s) {
                                    hub.lock().unwrap().handle(conn_id, ctrl);
                                }
                            }
                        }
                    }
                    Some(Err(_)) | None => break,
                }
            }
            _ = sd_rx.changed() => break,
        }
    }

    // 정리
    {
        let mut g = hub.lock().unwrap();
        g.teardown(conn_id);
        g.conns.remove(&conn_id);
    }
    writer.abort();
}

async fn acceptor(listener: TcpListener, hub: Hub, mut sd_rx: watch::Receiver<bool>) {
    let conn_sd = sd_rx.clone();
    loop {
        tokio::select! {
            res = listener.accept() => {
                if let Ok((stream, _)) = res {
                    let _ = stream.set_nodelay(true);
                    tokio::spawn(handle_conn(stream, hub.clone(), conn_sd.clone()));
                }
            }
            _ = sd_rx.changed() => break,
        }
    }
}

// ---- 로컬 IPv4 주소 열거(게스트가 입력할 호스트 IP 안내용) ------------------

fn local_ipv4_addrs() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        for iface in ifaces {
            if iface.is_loopback() {
                continue;
            }
            if let IpAddr::V4(v4) = iface.ip() {
                let s = v4.to_string();
                if !out.contains(&s) {
                    out.push(s);
                }
            }
        }
    }
    out
}

// ---- Tauri 상태 / 커맨드 ---------------------------------------------------

#[derive(Default)]
pub struct LanState(pub Mutex<LanRunning>);

#[derive(Default)]
pub struct LanRunning {
    shutdown: Option<watch::Sender<bool>>,
    port: u16,
    running: bool,
}

#[derive(Serialize)]
pub struct LanInfo {
    running: bool,
    port: u16,
    addrs: Vec<String>,
}

fn stop_inner(state: &LanState) {
    let mut g = state.0.lock().unwrap();
    if let Some(sd) = g.shutdown.take() {
        let _ = sd.send(true);
    }
    g.running = false;
    g.port = 0;
}

/// LAN 릴레이 서버를 0.0.0.0:port 로 시작. port 미지정/사용중이면 임의 포트로 폴백.
#[tauri::command]
pub async fn lan_start(state: State<'_, LanState>, port: Option<u16>) -> Result<LanInfo, String> {
    stop_inner(&state);
    let want = port.unwrap_or(DEFAULT_PORT);
    let listener = match TcpListener::bind(("0.0.0.0", want)).await {
        Ok(l) => l,
        Err(_) => TcpListener::bind(("0.0.0.0", 0))
            .await
            .map_err(|e| format!("bind 실패: {e}"))?,
    };
    let actual = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    let hub: Hub = Arc::new(Mutex::new(Inner::new()));
    let (sd_tx, sd_rx) = watch::channel(false);
    let beacon_rx = sd_rx.clone();
    tokio::spawn(acceptor(listener, hub, sd_rx));
    tokio::spawn(beacon(actual, beacon_rx));
    {
        let mut g = state.0.lock().unwrap();
        g.shutdown = Some(sd_tx);
        g.port = actual;
        g.running = true;
    }
    Ok(LanInfo {
        running: true,
        port: actual,
        addrs: local_ipv4_addrs(),
    })
}

/// 실행 중인 LAN 릴레이 서버를 중지(모든 연결 종료).
#[tauri::command]
pub fn lan_stop(state: State<'_, LanState>) -> Result<(), String> {
    stop_inner(&state);
    Ok(())
}

/// 현재 LAN 서버 상태 + 로컬 IPv4 주소 목록.
#[tauri::command]
pub fn lan_status(state: State<'_, LanState>) -> LanInfo {
    let (running, port) = {
        let g = state.0.lock().unwrap();
        (g.running, g.port)
    };
    LanInfo {
        running,
        port,
        addrs: local_ipv4_addrs(),
    }
}

// ---- UDP 디스커버리(호스트 자동 탐색) --------------------------------------

/// 호스트: 릴레이 포트를 담은 비콘을 1초마다 브로드캐스트(USB/Thunderbolt 직결 망에서도 도달).
async fn beacon(relay_port: u16, mut sd_rx: watch::Receiver<bool>) {
    let sock = match UdpSocket::bind(("0.0.0.0", 0)).await {
        Ok(s) => s,
        Err(_) => return,
    };
    let _ = sock.set_broadcast(true);
    let payload = format!("{{\"fetris\":1,\"port\":{relay_port}}}");
    let target = format!("255.255.255.255:{DISCOVERY_PORT}");
    loop {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(1000)) => {
                let _ = sock.send_to(payload.as_bytes(), &target).await;
            }
            _ = sd_rx.changed() => break,
        }
    }
}

#[derive(Serialize)]
pub struct DiscoveredHost {
    ip: String,
    port: u16,
}

/// 게스트: 잠시 비콘을 수신해 발견한 호스트(IP+릴레이 포트) 목록을 반환.
#[tauri::command]
pub async fn lan_discover() -> Result<Vec<DiscoveredHost>, String> {
    let dur = Duration::from_millis(1500);
    let sock = UdpSocket::bind(("0.0.0.0", DISCOVERY_PORT))
        .await
        .map_err(|e| format!("디스커버리 소켓 bind 실패: {e}"))?;
    let mut found: Vec<DiscoveredHost> = Vec::new();
    let mut buf = [0u8; 512];
    let deadline = tokio::time::Instant::now() + dur;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        tokio::select! {
            r = sock.recv_from(&mut buf) => {
                if let Ok((n, addr)) = r {
                    if let Ok(v) = serde_json::from_slice::<Value>(&buf[..n]) {
                        if v.get("fetris").is_some() {
                            let port = v.get("port").and_then(|p| p.as_u64()).unwrap_or(0) as u16;
                            let ip = addr.ip().to_string();
                            if port != 0 && !found.iter().any(|h| h.ip == ip && h.port == port) {
                                found.push(DiscoveredHost { ip, port });
                            }
                        }
                    }
                }
            }
            _ = tokio::time::sleep(remaining) => break,
        }
    }
    Ok(found)
}
