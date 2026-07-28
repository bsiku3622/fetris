# fetris-be

Fetris 대전용 WebSocket 릴레이 서버. 방 코드 기반 매칭 + sender-authoritative 메시지 중계만 담당하는 가벼운 서버입니다. 게임 로직/판정은 클라이언트가 처리하고, 서버는 방 참가자 사이에서 메시지를 그대로 전달합니다. 봇도 별도 프로세스가 참가자로 접속하는 구조라, 서버는 게임을 시뮬레이션하지 않습니다.

## 빠른 시작

```bash
npm install
npm run dev      # tsx watch, 기본 :8787
# 또는
npm run build && npm start
```

`PORT` 환경변수로 포트 변경, `GET /health` 로 헬스체크(`ok`).

## 엔드포인트

| 엔드포인트 | 용도 |
|---|---|
| `ws://…/` | 사람 클라이언트 |
| `ws://…/bot` | 봇 러너·봇 (아래 [봇 엔드포인트](#봇-엔드포인트)) |
| `GET /health` | 헬스체크 → `ok` |
| `GET /bots` | 등록된 봇 러너 목록·유휴 수 → JSON |

## 프로토콜

클라이언트 → 서버(`ClientControl`):

| 메시지 | 설명 |
|---|---|
| `{ t: "create", maxPlayers?, nick? }` | 방 생성 → `{ t: "created", code, myId }` 응답 |
| `{ t: "join", code, nick?, ticket? }` | 방 입장 → `{ t: "joined", ... }` / `{ t: "error", reason }` |
| `{ t: "relay", msg }` | 발신자 제외 방 전체에 게임 메시지 중계 |
| `{ t: "relay-to", targetId, msg }` | 특정 플레이어에게만 중계 |
| `{ t: "add-bot", nick? }` | (호스트) 대기 중인 러너에게 봇 초대 요청 |
| `{ t: "kick-bot", playerId }` | (호스트) 방에 있는 봇 퇴장 |
| `{ t: "bot-hello", name?, capacity? }` | (`/bot` 전용) 봇 러너 등록 |
| `{ t: "leave" }` | 방 나가기 |

서버 → 클라이언트(`ServerControl`): `created`, `joined`, `peer-joined`, `peer-left`, `error`, `relay`, `bot-ready`, `bot-invite`, `bot-pending`.

`relay`의 `msg`(게임 메시지)는 서버가 해석하지 않습니다. 방 정원은 `create`의 `maxPlayers`(2~8, 기본 4)로 정하고, 누가 나가면 남은 사람에게 `peer-left`가 전달됩니다. 마지막 인원이 나가면 방이 삭제되고, 호스트가 나가면 남은 사람 중 한 명이 호스트를 승계합니다(봇은 후순위). 30초 주기 ping으로 죽은 연결을 정리합니다.

## 봇 엔드포인트

서버는 **봇을 실행하지 않습니다.** 게임 로직이 없는 릴레이라는 성격을 유지한 채, 외부 봇 프로세스가 방에 들어올 자리만 열어줍니다. 봇도 결국 일반 참가자로 앉으므로 대전 로직은 기존과 동일하게 흘러갑니다.

역할이 둘로 나뉩니다.

- **러너(control-plane)** — `/bot`에 붙어 `bot-hello`로 등록하고 초대를 기다리는 연결. 한 프로세스가 `capacity`만큼 동시에 봇을 맡습니다.
- **봇(data-plane)** — 초대 하나당 새로 여는 `/bot` 연결. 발급받은 `ticket`으로 방에 착석합니다.

```
러너                     서버                      호스트
 │── bot-hello ─────────▶│                          │
 │◀───── bot-ready ──────│                          │
 │                       │◀──────── add-bot ────────│
 │◀──── bot-invite ──────│───── bot-pending ───────▶│
 │   (code, ticket)      │                          │
 │                       │                          │
봇 ── join(code,ticket) ▶│───── peer-joined ───────▶│
 │◀───── joined ─────────│                          │
```

착석 이후에는 `relay` / `relay-to`로 일반 참가자와 똑같이 게임 메시지를 주고받습니다. 방의 다른 참가자에게는 `PlayerInfo.isBot: true`로 보입니다.

### 규칙

- `add-bot`은 **호스트만** 보낼 수 있고, 초대 시점에 방 슬롯을 하나 예약합니다(정원 계산에 즉시 반영).
- 초대 후 15초 안에 봇이 착석하지 않으면 예약이 풀리고 호스트에게 `{ t: "error", reason: "bot-join-timeout" }`이 갑니다.
- 대기 중인 러너가 없거나 모두 `capacity`를 채웠으면 `no-bot-available`.
- `ticket`은 `/bot` 경로에서만 사용할 수 있습니다(사람 클라이언트가 봇 슬롯을 가로챌 수 없음).
- 사람이 모두 나가 봇만 남은 방은 봇 연결까지 닫고 정리합니다.
- 에러 사유: `not-in-room`, `not-host`, `room-full`, `no-bot-available`, `bot-join-timeout`, `invalid-ticket`, `bot-path-required`, `not-a-bot`, `bot-auth-failed`.

### 인증

`FETRIS_BOT_TOKEN`을 설정하면 `/bot?token=…`이 일치하는 연결만 봇으로 받아들입니다(불일치 시 `bot-auth-failed`와 함께 close 4401). 설정하지 않으면 봇 경로가 열려 있으므로, 공개 서버에서는 지정을 권장합니다. 사람 경로(`/`)는 토큰과 무관합니다.

### 참조 러너

`examples/bot-runner.mjs`가 등록 → 초대 수신 → 착석까지의 최소 흐름을 담고 있습니다.

```bash
npm run bot:example
# 또는
FETRIS_WS_URL=ws://localhost:8787 FETRIS_BOT_CAPACITY=4 node examples/bot-runner.mjs
```

이 예제에는 플레이 로직이 없습니다(판이 시작되면 잠시 뒤 항복). 실제 봇은 `@fetris/engine`을 그대로 import해 보드를 시뮬레이션하면서 `attack` / `board` / `dead` 게임 메시지를 내보내면 됩니다 — 엔진이 워크스페이스 공유 패키지라 서버·클라이언트와 같은 코드로 돌릴 수 있습니다.

## 테스트

```bash
npm test         # vitest — 방 생성/입장/중계/이탈 검증
```

## 우분투 배포

### 1) systemd (권장)

빌드 후 `dist/`를 서버에 두고:

```ini
# /etc/systemd/system/fetris-be.service
[Unit]
Description=Fetris relay server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/fetris-be
Environment=PORT=8787
ExecStart=/usr/bin/node dist/index.js
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now fetris-be
```

### 2) TLS + wss 프록시 (Caddy 예시)

브라우저에서 `wss://`로 붙으려면 앞단에서 TLS 종단이 필요합니다.

```
# Caddyfile
fetris-ws.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Caddy는 Let's Encrypt 인증서를 자동 발급/갱신합니다. 이후 프론트는 `wss://fetris-ws.example.com`으로 연결합니다.

### 3) Docker (대안)

```bash
docker build -t fetris-be .
docker run -d --restart=always -p 8787:8787 --name fetris-be fetris-be
```

## 프론트 연결

Fetris 프론트의 대전 화면에서 위 `wss://` 주소를 서버 URL로 지정하면 됩니다(빌드 시 환경변수 `VITE_FETRIS_WS_URL`).
