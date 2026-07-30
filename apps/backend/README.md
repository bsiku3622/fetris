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
| `{ t: "set-role", role }` | 참가자 ↔ 관전자 전환(lobby 전용) |
| `{ t: "config", config }` | (호스트) 매치 설정 갱신 |
| `{ t: "start-match" }` | (호스트) 매치 시작 |
| `{ t: "skip-results" }` | 결과 대기시간 건너뛰고 대기실로 |
| `{ t: "ko" }` | 내가 탈락했다는 자기 신고 |
| `{ t: "replay", matchId, seed, handling, frames, keys, garbage, fingerprint, stats }` | 매치 종료 후 기록 제출(검증 + 방 배포) |
| `{ t: "relay", msg }` | 발신자 제외 방 전체에 게임 메시지 중계 |
| `{ t: "relay-to", targetId, msg }` | 특정 플레이어에게만 중계 |
| `{ t: "add-bot", nick?, runnerId? }` | (호스트) 봇 초대 — runnerId로 지목 가능 |
| `{ t: "list-runners" }` | 부를 수 있는 봇 러너 목록 |
| `{ t: "kick-bot", playerId }` | (호스트) 방에 있는 봇 퇴장 |
| `{ t: "bot-hello", name?, capacity? }` | (`/bot` 전용) 봇 러너 등록 |
| `{ t: "leave" }` | 방 나가기 |

서버 → 클라이언트(`ServerControl`): `created`, `joined`, `state`, `match-start`, `ko`, `match-end`, `error`, `relay`, `bot-ready`, `bot-invite`, `bot-pending`, `runners`.

`relay`의 `msg`(게임 메시지)는 서버가 해석하지 않습니다. 방 정원은 `create`의 `maxPlayers`로 정하며 **0이 기본(제한 없음)**, 값을 주면 2~8로 잡힙니다. 정원은 참가자만 세고 관전자는 자리를 차지하지 않습니다. 방에 변화가 생기면(입퇴장·역할·설정·페이즈) `state`로 **방 전체 스냅샷**이 브로드캐스트됩니다 — 개별 이벤트를 추적하는 대신 상태를 통째로 갈아끼우면 됩니다. 마지막 인원이 나가면 방이 삭제되고, 호스트가 나가면 남은 사람 중 한 명이 승계합니다(봇은 후순위). 25초 주기 ping을 보내며, 연속 3회 응답이 없어야 연결을 끊습니다(순단으로 튕기지 않도록).

## 매치 진행

서버는 게임을 시뮬레이션하지 않지만 **매치 진행은 소유합니다.** 방은 다음 상태를 오갑니다.

```
lobby ──start-match──▶ playing ──마지막 1인──▶ results
  ▲                                              │
  └──(6초 후 자동 복귀 · skip-results로 즉시)─────┘
```

시작 카운트다운은 서버가 세지 않습니다. 엔진이 판을 열면서 자체 Ready 카운트다운을 돌리므로(보드는 떠 있고 입력만 잠깁니다) 서버가 또 세면 이중이 되고, 그동안 클라이언트는 보여줄 게 없어 화면이 멈춘 것처럼 보입니다.

- **참가자와 관전자** — `role: "player"`인 사람만 매치를 뜁니다. 매치 진행 중 입장하면 자동으로 관전자가 되고 다음 판부터 참가합니다.
- **시작 조건** — 호스트만 시작할 수 있고, 설정이 등록돼 있어야 하며, 참가자가 2명 이상이어야 합니다. 준비 절차는 없습니다 — 호스트가 누르면 바로 시작합니다.
- **라스트맨 스탠딩** — `ko` 신고가 올 때마다 탈락 역순으로 순위가 확정됩니다(첫 탈락자가 꼴찌). 생존자가 1명이 되면 그 사람이 우승하고 `wins`가 1 오릅니다. 매치 중 이탈도 탈락으로 처리합니다.
- **대기실 복귀** — 결과를 보여준 뒤 lobby로 돌아갑니다. 누구든 `skip-results`로 기다림을 건너뛸 수 있습니다.
- **시리즈(FT)** — `MatchConfig.firstTo`가 0보다 크면 먼저 그만큼 이긴 사람이 시리즈를 가져갑니다. 그 판의 `match-end`에 `seriesWinnerId`가 실리고 **전원의 승수가 0으로 초기화**되어 다음 시리즈가 시작됩니다. 0이면 목표 없이 계속 쌓입니다.

`MatchConfig`에는 `rule`·`handling`·`simRate`가 함께 실립니다. 서버는 내용을 해석하지 않지만, 리플레이 검증에서 **같은 simRate와 핸들링으로 재현해야** 하므로 매치 시작 시점에 확정해 둡니다 — simRate가 다르면 같은 시드·입력이라도 결과가 갈립니다.

KO는 자기 신고입니다. 서버는 보드를 실시간으로 보지 않으므로 그 순간에는 신고를 그대로 믿고, 대신 매치가 끝난 뒤 리플레이로 대조합니다.

## 리플레이 검증

매치가 끝나면 각 클라이언트가 **프레임 단위 원시 입력 로그**와 최종 상태 지문을 제출합니다. 서버는 같은 시드·룰·핸들링·simRate로 `@fetris/engine`을 돌려 재현한 뒤 지문을 맞춰봅니다.

```
{ t: "replay", matchId,
  frames,
  keys:    [frame, action, down, ...],
  garbage: [frame, n, ...holes, ...],
  fingerprint }
```

재현이 성립하는 근거는 엔진 쪽에 있습니다. `Game.pressDir`/`releaseDir`은 상태만 바꾸고 실제 이동은 `update()`에서 일어나므로, 프레임 중간에 누른 키의 효과는 어차피 다음 스텝부터 나타납니다. 따라서 **"프레임 F의 update 직전"으로 기록해도 원본과 같은 전개**가 나오고, 입력 지연을 늘리지 않아도 됩니다.

- 지문이 어긋나면 서버 로그에 남기고 제출자에게 `replay-mismatch`를 보냅니다. **자동 제재는 하지 않습니다** — 오탐으로 정상 플레이어를 쫓아내는 쪽이 더 나쁩니다.
- `sharePieces`가 꺼져 있으면 참가자마다 시드가 달라 서버가 재현할 근거가 없으므로 건너뜁니다.
- 재현은 CPU를 쓰므로 이벤트 루프 밖(`setImmediate`)으로 미루고, 프레임·키 길이에 상한을 둡니다.

## 매치 녹화

**판을 다시 보는 근거는 서버가 직접 갖습니다.** 중계하는 김에 방 전체로 나가는 보드 스냅샷에 시간축을 붙여 받아 적고(페이로드는 여전히 해석하지 않습니다 — 종류만 봅니다), 판이 끝나면 그 판의 녹화로 굳혀 둡니다. 참가자가 아무것도 내주지 않아도 — 리플레이를 지원하지 않는 봇만 뛰는 방이라도 — 판 전체가 남습니다.

내려받기는 `get-recording`으로 요청할 때만 보냅니다(몇 MB가 될 수 있어 자동으로 뿌리지 않습니다). 방마다 상한이 있고, 넘으면 그 지점에서 멈추고 `truncated`로 표시합니다.

매끄러움은 스냅샷 주기만큼입니다 — 관전자가 실시간으로 보던 것과 같은 수준입니다. 여기에 **검증용 입력 로그를 낸 참가자는 60Hz 정밀 재현으로 승급**합니다. 즉 녹화가 바닥이고 입력 로그는 화질 개선입니다. 클라이언트가 둘을 한 파일로 합쳐 내려받습니다.

제출은 검증만 하고 끝나지 않습니다. 서버는 받은 기록을 `replay-record`로 방에 흘려주고, 클라이언트가 녹화와 함께 묶습니다.

**감도는 사람마다 다릅니다.** 핸들링은 마우스 감도 같은 개인 설정이라 방이 강제하지 않습니다. 그래서 제출에 `handling`을 함께 싣고 서버도 그 값으로 재현합니다(전부 정상 범위의 설정값이라 자기 신고로 얻을 이득은 없습니다). `seed`도 같은 이유로 함께 옵니다 — `sharePieces`가 꺼져 있으면 참가자마다 시드가 달라 서버가 알 수 없습니다.

**대전은 키 입력만으로 결정되지 않습니다.** 상대가 보낸 가비지는 시뮬레이션 바깥에서 들어오는 입력이라, `garbage` 로그가 함께 오지 않으면 정직한 판도 전부 불일치로 잡힙니다. 다만 이 로그는 제출자가 스스로 신고하는 값입니다 — 서버는 게임 페이로드를 해석하지 않아 대조할 원본이 없습니다. 즉 검증이 보증하는 것은 "제출한 입력이 정말 그 결과를 만드는가"까지이고, 가비지 신고 자체의 진위는 범위 밖입니다.

**simRate가 결과를 바꿉니다.** `update(1)` 한 번과 `update(0.5)` 두 번은 조각 잠금 타이밍이 달라 다른 상태로 끝납니다. 그래서 `MatchConfig.simRate`를 매치 시작 시점에 못박고 검증에서 그대로 씁니다. 이걸 어기면 정상 플레이어가 전부 불일치로 잡힙니다.

## 네트워크

WebSocket 압축(`permessage-deflate`)을 **컨텍스트 유지 상태로** 켭니다. 트래픽의 대부분은 보드 스냅샷이고 연달아 오는 스냅샷은 서로 거의 같아서, 메시지마다 따로 압축하면 3배 남짓이지만 컨텍스트를 이어가면 같은 자료가 50배 이상 줄어듭니다(실측: 스냅샷 367KB → 소켓 6.8KB). 작은 제어 메시지는 압축 이득보다 오버헤드가 커서 `threshold` 아래로 그냥 흘려보냅니다.

방 브로드캐스트는 직렬화를 한 번만 합니다. 같은 객체를 수신자 수만큼 다시 JSON으로 만들면 1KB가 넘는 스냅샷에서는 인원에 비례해 그대로 CPU가 낭비됩니다.

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
봇 ── join(code,ticket) ▶│───────── state ─────────▶│
 │◀───── joined ─────────│                          │
```

착석 이후에는 `relay` / `relay-to`로 일반 참가자와 똑같이 게임 메시지를 주고받습니다. 방의 다른 참가자에게는 `PlayerInfo.isBot: true`로 보입니다.

### 계획 고스트 (표시 전용)

봇이 "이렇게 놓을 생각"을 반투명 미노로 자기 보드에 띄울 수 있습니다. AI가 가방 단위로 세운 계획을 보여주는 용도입니다.

```jsonc
{ "t": "plan", "set":    [{ "id": "p0", "piece": 6, "rot": 0, "x": 3, "y": 38, "alpha": 0.55 }] }
{ "t": "plan", "add":    [{ "id": "p1", "piece": 4, "rot": 0, "x": 0, "y": 36 }] }
{ "t": "plan", "remove": ["p0"] }
```

`relay`로 감싸지 않는 제어 메시지입니다 — **상태를 서버가 소유**하기 때문입니다. 그래서 서버가 세 가지를 알아서 합니다.

- 계획한 칸이 보드에서 전부 메워지면(= 그 자리에 조각이 놓이면) 그 고스트를 걷어냅니다.
- 판이 끝나거나 시작할 때 전부 비웁니다.
- 방을 나간 사람의 계획은 지웁니다.

바뀔 때마다 `{ t: "plan-state", playerId, ghosts }`로 방 전체에 뿌리고, 보드 스냅샷과 같은 시간축에 녹화합니다 — 관전자도, 나중에 리플레이를 보는 사람도 그때 떠 있던 계획을 그대로 봅니다.

**게임 상태가 아닙니다.** 시뮬레이션·판정·리플레이 검증 어디에도 끼지 않아 결정론을 건드리지 않습니다.

자세한 사용법은 [docs/plan-ghosts.md](docs/plan-ghosts.md)에 있습니다.

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

토큰 관리는 관리 웹이나 CLI로 합니다. **서버는 파일 변경을 스스로 감지하므로 재시작이 필요 없습니다.**

```bash
FETRIS_BOT_TOKENS=/srv/fetris/bot-tokens.json npm run bot:token -- add 친구A "연습 상대"
FETRIS_BOT_TOKENS=/srv/fetris/bot-tokens.json npm run bot:token -- list
FETRIS_BOT_TOKENS=/srv/fetris/bot-tokens.json npm run bot:token -- revoke 친구A
```

토큰 파일은 릴레이가 읽을 수 있어야 합니다 — 관리 도구가 쓰고 서비스 사용자가 읽도록 `chown baeks:www-data` + `chmod 640`으로 둡니다.

### 관리 웹 (VPN 전용)

터미널 없이 발급/폐기하려면 별도 프로세스로 도는 관리 서버를 씁니다.

```bash
ADMIN_HOST=10.8.0.1 ADMIN_PORT=8788 \
FETRIS_BOT_TOKENS=/srv/fetris/bot-tokens.json \
npm run start:admin -w fetris-be
```

**로그인이 없습니다.** WireGuard 주소에만 바인딩하는 것이 유일한 접근 통제이므로 `0.0.0.0`으로 열면 안 됩니다. 릴레이와 별도 프로세스라 관리 서버가 죽어도 대전은 계속되고, 토큰 파일을 써야 하므로 파일 소유자(`User=baeks`)로 실행합니다.

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

`examples/bot-runner.mjs`가 등록 → 초대 수신 → 착석 → 실제 플레이까지의 흐름을 담고 있습니다.

```bash
npm run bot:example
# 또는
FETRIS_WS_URL=ws://localhost:8787 FETRIS_BOT_CAPACITY=4 node examples/bot-runner.mjs
```

예제에는 **실제로 두는 두뇌가 들어 있습니다** — 모든 회전×열을 놓아보고 구멍·굴곡·높이로 점수를 매겨 고릅니다. 채팅 커맨드(`!bot pps 2.5`, `!bot target elims`, `!bot status`)로 속도와 타깃 전략을 조절할 수 있습니다. 엔진이 워크스페이스 공유 패키지라 서버·클라이언트와 같은 코드로 돌아갑니다.

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
