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
| `{ t: "create", maxPlayers?, nick? }` | 방 생성 → `{ t: "created", code, myId, state }` |
| `{ t: "join", code, nick?, ticket? }` | 방 입장 → `{ t: "joined", ... }` / `{ t: "error", reason }` |
| `{ t: "ready", ready }` | 준비 토글(lobby 전용) |
| `{ t: "set-role", role }` | 참가자 ↔ 관전자 전환(lobby 전용) |
| `{ t: "config", config }` | (호스트) 매치 설정 갱신 — 준비가 전부 풀린다 |
| `{ t: "start-match" }` | (호스트) 카운트다운 시작 |
| `{ t: "ko" }` | 내가 탈락했다는 자기 신고 |
| `{ t: "replay", matchId, frames, keys }` | 매치 종료 후 리플레이 제출(검증용, 아직 미구현) |
| `{ t: "relay", msg }` | 발신자 제외 방 전체에 게임 메시지 중계 |
| `{ t: "relay-to", targetId, msg }` | 특정 플레이어에게만 중계 |
| `{ t: "add-bot", nick? }` | (호스트) 대기 중인 러너에게 봇 초대 요청 |
| `{ t: "kick-bot", playerId }` | (호스트) 방에 있는 봇 퇴장 |
| `{ t: "bot-hello", name?, capacity? }` | (`/bot` 전용) 봇 러너 등록 |
| `{ t: "leave" }` | 방 나가기 |

서버 → 클라이언트(`ServerControl`): `created`, `joined`, `state`, `countdown`, `match-start`, `ko`, `match-end`, `error`, `relay`, `bot-ready`, `bot-invite`, `bot-pending`.

`relay`의 `msg`(게임 메시지)는 서버가 해석하지 않습니다. 방 정원은 `create`의 `maxPlayers`(2~8, 기본 4)로 정합니다. 방에 변화가 생기면(입퇴장·준비·역할·설정·페이즈) `state`로 **방 전체 스냅샷**이 브로드캐스트됩니다 — 개별 이벤트를 추적하는 대신 상태를 통째로 갈아끼우면 됩니다. 마지막 인원이 나가면 방이 삭제되고, 호스트가 나가면 남은 사람 중 한 명이 승계합니다(봇은 후순위). 30초 주기 ping으로 죽은 연결을 정리합니다.

## 매치 진행

서버는 게임을 시뮬레이션하지 않지만 **매치 진행은 소유합니다.** 방은 다음 상태를 오갑니다.

```
lobby ──start-match──▶ countdown ──(3초)──▶ playing ──마지막 1인──▶ results
  ▲                                                                    │
  └────────────────────────(6초 후 자동 복귀)───────────────────────────┘
```

- **참가자와 관전자** — `role: "player"`인 사람만 매치를 뜁니다. 매치 진행 중 입장하면 자동으로 관전자가 되고 다음 판부터 참가합니다.
- **시작 조건** — 호스트만 시작할 수 있고, 설정이 등록돼 있어야 하며, 참가자가 2명 이상이고 전원 준비 상태여야 합니다. 봇은 항상 준비된 것으로 칩니다.
- **라스트맨 스탠딩** — `ko` 신고가 올 때마다 탈락 역순으로 순위가 확정됩니다(첫 탈락자가 꼴찌). 생존자가 1명이 되면 그 사람이 우승하고 `wins`가 1 오릅니다. 매치 중 이탈도 탈락으로 처리합니다.
- **대기실 복귀** — 결과를 보여준 뒤 준비 상태를 풀고 lobby로 돌아갑니다. 누적 승수는 방에 머무는 동안 유지됩니다.

`MatchConfig`에는 `rule`·`handling`·`simRate`가 함께 실립니다. 서버는 내용을 해석하지 않지만, 리플레이 검증에서 **같은 simRate와 핸들링으로 재현해야** 하므로 매치 시작 시점에 확정해 둡니다 — simRate가 다르면 같은 시드·입력이라도 결과가 갈립니다.

KO는 자기 신고입니다. 서버는 보드를 실시간으로 보지 않으므로 그 순간에는 신고를 그대로 믿고, 대신 매치가 끝난 뒤 리플레이로 대조합니다.

## 리플레이 검증

매치가 끝나면 각 클라이언트가 **프레임 단위 원시 입력 로그**와 최종 상태 지문을 제출합니다. 서버는 같은 시드·룰·핸들링·simRate로 `@fetris/engine`을 돌려 재현한 뒤 지문을 맞춰봅니다.

```
{ t: "replay", matchId, frames, keys: [frame, action, down, ...], fingerprint }
```

재현이 성립하는 근거는 엔진 쪽에 있습니다. `Game.pressDir`/`releaseDir`은 상태만 바꾸고 실제 이동은 `update()`에서 일어나므로, 프레임 중간에 누른 키의 효과는 어차피 다음 스텝부터 나타납니다. 따라서 **"프레임 F의 update 직전"으로 기록해도 원본과 같은 전개**가 나오고, 입력 지연을 늘리지 않아도 됩니다.

- 지문이 어긋나면 서버 로그에 남기고 제출자에게 `replay-mismatch`를 보냅니다. **자동 제재는 하지 않습니다** — 오탐으로 정상 플레이어를 쫓아내는 쪽이 더 나쁩니다.
- `sharePieces`가 꺼져 있으면 참가자마다 시드가 달라 서버가 재현할 근거가 없으므로 건너뜁니다.
- 재현은 CPU를 쓰므로 이벤트 루프 밖(`setImmediate`)으로 미루고, 프레임·키 길이에 상한을 둡니다.

**simRate가 결과를 바꿉니다.** `update(1)` 한 번과 `update(0.5)` 두 번은 조각 잠금 타이밍이 달라 다른 상태로 끝납니다. 그래서 `MatchConfig.simRate`를 매치 시작 시점에 못박고 검증에서 그대로 씁니다. 이걸 어기면 정상 플레이어가 전부 불일치로 잡힙니다.

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
- 에러 사유: `not-in-room`, `not-host`, `not-in-lobby`, `room-full`, `no-bot-available`, `runner-not-found`, `runner-busy`, `bot-join-timeout`, `invalid-ticket`, `bot-path-required`, `not-a-bot`, `bot-auth-failed`.

### 인증 — 러너별 토큰

`FETRIS_BOT_TOKENS`에 토큰 파일 경로를 주면 봇 경로에 **토큰이 필수**가 되고, 토큰마다 소유자가 붙습니다.

```jsonc
// /srv/fetris/bot-tokens.json
{
  "tokens": [
    { "token": "…", "owner": "재원", "label": "메인 봇" },
    { "token": "…", "owner": "친구A" }
  ]
}
```

토큰 관리는 CLI로 합니다. **서버는 파일 변경을 스스로 감지하므로 재시작이 필요 없습니다.**

```bash
FETRIS_BOT_TOKENS=/srv/fetris/bot-tokens.json npm run bot:token -- add 친구A "연습 상대"
FETRIS_BOT_TOKENS=/srv/fetris/bot-tokens.json npm run bot:token -- list
FETRIS_BOT_TOKENS=/srv/fetris/bot-tokens.json npm run bot:token -- revoke 친구A
```

**소유자는 토큰에 묶여 있어 러너가 사칭할 수 없습니다.** `bot-hello`에 무슨 이름을 실어 보내든 서버는 접속 토큰에서 확정한 소유자를 씁니다. 이 값이 러너 목록과 방 로스터(`PlayerInfo.botOwner`)에 그대로 표시됩니다.

토큰 파일을 지정하지 않으면 봇 경로가 열려 있습니다(로컬 개발 편의). 공개 서버라면 반드시 지정하세요 — 그렇지 않으면 주소만 아는 누구나 러너를 등록할 수 있습니다. 사람 경로(`/`)는 토큰과 무관합니다.

구식 단일 토큰(`FETRIS_BOT_TOKEN`)도 계속 동작하지만 소유자 구분이 없습니다.

### 봇 고르기

호스트는 어느 봇을 부를지 지목할 수 있습니다.

```jsonc
{ "t": "list-runners" }                        // → { "t": "runners", "runners": [...] }
{ "t": "add-bot", "runnerId": "r1a2b" }        // 지목
{ "t": "add-bot" }                             // 생략하면 여유가 가장 많은 러너를 자동 선택
```

지목한 러너가 없으면 `runner-not-found`, 정원을 채웠으면 `runner-busy`가 돌아옵니다. 목록 조회는 방에 있는 사람이면 누구나 할 수 있고, 부르는 것은 호스트 전용입니다.

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

서버는 이 패키지만이 아니라 **워크스페이스 저장소 전체**를 받아야 합니다 — 릴레이가 리플레이 검증에 `@fetris/engine`을 쓰기 때문입니다.

### 1) 저장소 배치와 빌드

```bash
sudo git clone https://github.com/bsiku3622/fetris.git /srv/fetris
sudo chown -R $USER:$USER /srv/fetris
cd /srv/fetris
npm install                      # 워크스페이스 전체(node_modules는 루트에 호이스팅)
npm run build:engine             # backend가 dist를 참조하므로 반드시 선행
npm run build -w fetris-be
```

엔진을 고친 뒤에는 **`build:engine`을 다시 돌려야** 릴레이에 반영됩니다.

### 2) systemd

```ini
# /etc/systemd/system/fetris-be.service
[Unit]
Description=Fetris relay server
After=network.target

[Service]
Type=simple
# node_modules는 /srv/fetris에 호이스팅되어 있고 @fetris/engine은 심볼릭 링크다
WorkingDirectory=/srv/fetris/apps/backend
Environment=PORT=8787
# 공개 서버라면 봇 경로를 잠근다
# Environment=FETRIS_BOT_TOKEN=...
ExecStart=/usr/bin/node dist/index.js
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now fetris-be
```

### 3) TLS + wss 프록시

브라우저에서 `wss://`로 붙으려면 앞단에서 TLS 종단이 필요합니다. nginx 예시:

```nginx
server {
    listen 443 ssl;
    server_name fetris-be.example.com;

    location / {
        proxy_pass http://127.0.0.1:8787;
        # WebSocket 업그레이드에 필요 — 빠지면 연결이 즉시 끊긴다
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }

    ssl_certificate     /etc/letsencrypt/live/fetris-be.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/fetris-be.example.com/privkey.pem;
}
```

Caddy를 쓴다면 `fetris-be.example.com { reverse_proxy 127.0.0.1:8787 }` 한 줄로 끝나고 인증서도 자동입니다.

### 4) 갱신

```bash
cd /srv/fetris && git pull
npm install && npm run build:engine && npm run build -w fetris-be
sudo systemctl restart fetris-be
```

### 3) Docker (대안)

```bash
docker build -t fetris-be .
docker run -d --restart=always -p 8787:8787 --name fetris-be fetris-be
```

## 프론트 연결

Fetris 프론트의 대전 화면에서 위 `wss://` 주소를 서버 URL로 지정하면 됩니다(빌드 시 환경변수 `VITE_FETRIS_WS_URL`).
