# Fetris 봇 API

Fetris 릴레이 서버에 봇을 붙이는 방법 전부.

**서버는 봇을 실행하지 않습니다.** 게임 로직이 없는 릴레이라는 성격을 유지한 채, 외부 봇 프로세스가 방에 들어올 자리만 열어줍니다. 봇도 결국 일반 참가자로 앉으므로 대전 로직은 사람과 똑같이 흘러갑니다.

- 릴레이: `wss://fetris-be.bsiku.dev` (봇 경로 `/bot`)
- 참조 구현: [`apps/backend/examples/bot-runner.mjs`](https://github.com/bsiku3622/fetris/blob/main/apps/backend/examples/bot-runner.mjs)
- 저장소: <https://github.com/bsiku3622/fetris>

---

## 1. 시작하기

엔진을 그대로 쓰는 게 가장 빠릅니다. 봇이 자기 판을 시뮬레이션해야 하는데, 그 판은 서버·다른 참가자가 돌리는 것과 **한 프레임도 어긋나면 안 되기** 때문입니다.

```bash
git clone https://github.com/bsiku3622/fetris.git
cd fetris
npm install
npm run build:engine        # 봇은 dist를 참조합니다

# 로컬에서 돌려보기 (터미널 3개)
npm run dev:server                            # 릴레이 :8787
node apps/backend/examples/bot-runner.mjs     # 참조 러너
npm run dev                                   # 게임 클라이언트 :1420
```

클라이언트에서 방을 만들고 **+ 봇**을 누르면 붙습니다.

공개 릴레이에 붙이려면 토큰이 필요합니다. 토큰마다 소유자가 묶여 있어 러너가 스스로 사칭할 수 없습니다.

```bash
FETRIS_WS_URL=wss://fetris-be.bsiku.dev FETRIS_BOT_TOKEN=... node examples/bot-runner.mjs
```

---

## 2. 연결 구조

역할이 둘로 나뉩니다. **둘은 다른 WebSocket 연결입니다.**

- **러너 (control-plane)** — `/bot`에 붙어 `bot-hello`로 등록하고 초대를 기다립니다. 한 프로세스가 `capacity`만큼 동시에 봇을 맡습니다.
- **봇 (data-plane)** — 초대 하나당 새로 여는 `/bot` 연결. 발급받은 `ticket`으로 방에 착석합니다.

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

접속 주소:

```
wss://fetris-be.bsiku.dev/bot?token=<TOKEN>
```

`ticket`은 `/bot` 경로에서만 쓸 수 있습니다 — 사람 클라이언트가 봇 슬롯을 가로챌 수 없습니다.

---

## 3. 제어 메시지

### 봇 → 서버

| 메시지 | 설명 |
|---|---|
| `{ t: "bot-hello", name?, capacity? }` | 러너 등록. `capacity`는 1~16 |
| `{ t: "join", code, ticket, nick?, handling? }` | 티켓으로 착석 |
| `{ t: "relay", msg, mid? }` | 발신자 제외 방 전체에 게임 메시지 중계 |
| `{ t: "relay-to", targetId, msg, mid? }` | 특정 참가자에게만 중계 |
| `{ t: "plan", set? \| add? \| remove? }` | 표시 전용 계획 고스트 |
| `{ t: "ko" }` | 내가 톱아웃했다는 자기 신고 |
| `{ t: "replay", … }` | 판이 끝난 뒤 기록 제출 |
| `{ t: "resume", token, lastSeenId? }` | 끊겼던 자리로 복귀 |
| `{ t: "leave" }` | 방 나가기 |

### 서버 → 봇

| 메시지 | 설명 |
|---|---|
| `bot-ready` | 러너 등록 완료. `runner.id`·`owner`·`capacity` |
| `bot-invite` | 초대. `code`·`ticket`·`nick` |
| `joined` | 착석 완료. `myId`가 내 플레이어 id, `session`은 복귀 토큰 |
| `state` | 방 전체 스냅샷. 바뀔 때마다 통째로 옵니다 — 이벤트를 따라가지 말고 상태를 갈아끼우세요 |
| `match-start` | 판 시작 (아래 참고) |
| `ko` | 누군가 탈락. `playerId`·`placement`·`remaining` |
| `match-end` | 판 종료. `standings`에 순위, `seriesWinnerId`가 있으면 시리즈까지 끝 |
| `plan-state` | 누군가의 계획 고스트가 바뀜 |
| `relay` | 다른 참가자가 보낸 게임 메시지. `from`이 발신자 |
| `error` | 오류. `reason` |

서버가 보내는 모든 메시지에 증가하는 `id`가 붙습니다. 순단 복귀 때 어디까지 받았는지 대조하는 값입니다.

### match-start

```jsonc
{
  "t": "match-start",
  "matchId": 3,
  "seed": 2028105991,
  "config": { "rule": {…}, "handling": {…}, "simRate": 60,
              "sharePieces": true, "undo": false, "attackMul": 1, "firstTo": 0 },
  "players": ["p1ab", "p2cd", "p3ef"],
  "sim": [
    { "id": "p1ab", "seed": 2028105991, "handling": {…} },
    { "id": "p2cd", "seed": 2028105991, "handling": {…} }
  ]
}
```

- **시드는 서버가 나눠줍니다.** `sim`에서 자기 항목을 찾아 쓰세요. 직접 뽑으면 서버가 재현할 근거를 잃어 검증이 어긋납니다. 조각 순서를 공유하지 않는 방(`sharePieces: false`)이면 참가자마다 다릅니다.
- `sim`에는 **상대의 시드·감도도** 들어 있습니다. 상대 판을 그대로 따라 돌리는 데 쓰입니다.
- `players`에 자기 id가 없으면 이번 판은 관전입니다 — 판을 열지 마세요.
- `config.simRate`(60/120/240)와 감도가 다르면 같은 입력이라도 결과가 갈립니다. 반드시 받은 값으로 도세요.

---

## 4. 게임 메시지

`relay` / `relay-to`의 `msg`로 실려 가는 페이로드입니다. **서버는 내용을 해석하지 않고 그대로 넘깁니다.**

| 종류 | 설명 |
|---|---|
| `{ t: "sync", upto, keys?, ige? }` | **입력 릴레이.** 남들 화면에 내 판이 보이게 하는 주된 통로 |
| `{ t: "full", frame, snap }` | 상태 키프레임. 낮은 빈도로만 |
| `{ t: "attack", holes, targetId? }` | 상쇄하고 남은 공격. `holes`는 줄마다 뚫린 컬럼 번호 |
| `{ t: "chat", nick, text }` | 채팅 |
| `{ t: "board", snap }` | 옛 방식의 보드 스냅샷 (호환용, 권장하지 않음) |

---

## 5. 입력 릴레이

**보드가 아니라 누른 키를 보냅니다.**

예전에는 보드를 통째로 직렬화해 주기적으로 뿌렸습니다. 지금은 키만 흘려보내고, 받는 쪽이 같은 시드·감도로 다시 돌려 그 판을 재현합니다. 엔진이 결정론적이라 성립하는 구조입니다.

트래픽이 두 자릿수 배로 적고, 스냅샷 사이가 멈춰 보이던 문제가 사라져 **조각이 실제로 떨어지는 게 보입니다.** 서버도 이걸 받아 적어 두므로 봇이 아무것도 제출하지 않아도 그 판이 60Hz로 남습니다.

### 인코딩

둘 다 평탄한 숫자 배열입니다. `@fetris/engine/replay`의 `ReplayRecorder`가 쌓는 형식 그대로입니다.

```
keys: [프레임, 액션, 눌림, 프레임, 액션, 눌림, …]
ige:  [프레임, 줄수, 구멍0, 구멍1, …, 프레임, 줄수, …]
```

액션 코드:

| 값 | 액션 | 값 | 액션 |
|---|---|---|---|
| 0 | MoveLeft | 4 | RotateCCW |
| 1 | MoveRight | 5 | Rotate180 |
| 2 | SoftDrop | 6 | Hold |
| 3 | RotateCW | 7 | HardDrop |

`눌림`은 1(누름) 또는 0(뗌)입니다. 이산 동작(회전·홀드·하드드롭)은 누름만 의미가 있습니다.

### 보내기

```js
import { ReplayRecorder, ReplayAction } from "@fetris/engine/replay";

const recorder = new ReplayRecorder();
let sentKeys = 0, sentIge = 0, streamAccum = 0, keyframeAccum = 0;

// 매 시뮬 스텝
function step(dt) {
  const cmd = think();          // 이 안에서 recorder.push(...)로 입력을 남긴다
  recorder.commitFrame();       // 대기 중인 입력을 이번 프레임으로 확정
  game.update(dt, cmd, 0);
  // …

  if (++streamAccum >= 4) { streamAccum = 0; flushStream(); }
  if (++keyframeAccum >= 120) {
    keyframeAccum = 0;
    sendGame({ t: "full", frame: recorder.frame, snap: game.serialize() });
  }
}

// 기록기에 새로 쌓인 만큼만 보낸다
function flushStream() {
  const msg = { t: "sync", upto: recorder.frame };
  if (recorder.keys.length > sentKeys) {
    msg.keys = recorder.keys.slice(sentKeys);
    sentKeys = recorder.keys.length;
  }
  if (recorder.garbage.length > sentIge) {
    msg.ige = recorder.garbage.slice(sentIge);
    sentIge = recorder.garbage.length;
  }
  sendGame(msg);
}
```

지켜야 할 것 다섯 가지:

1. **`upto`는 약속입니다.** "이 프레임까지는 빠짐없이 보냈다"는 뜻이고, 받는 쪽 미러는 딱 거기까지만 진행합니다. 실제보다 앞서 부르면 남의 화면에서 내 판이 어긋납니다.
2. **스트림을 먼저, 키프레임을 나중에.** 순서가 뒤집히면 미러가 키프레임으로 앞질러 간 다음 지나간 입력을 다시 먹습니다. 키프레임 주기를 스트림 주기의 배수로 두면 자연히 지켜집니다.
3. **받은 가비지도 남기세요.** 대전은 키 입력만으로 판이 결정되지 않습니다. `recorder.pushGarbage(holes)`를 `game.receiveGarbage(...)`와 같은 자리에서 부르세요.
4. **톱아웃 직전에 한 번 더 흘려보내세요.** 안 그러면 마지막 몇 프레임이 남들 화면에 닿지 않습니다.
5. **중계 봉투에 `mid`(지금 판 번호)를 붙이세요.** 판이 바뀌는 찰나에 지난 판 입력을 흘리면 상대의 새 미러가 그걸 먹고 보드가 통째로 어긋납니다. 서버가 이 번호를 지금 판과 대조해 걸러줍니다 — `{ t: "relay", msg, mid: matchId }`. 판과 무관한 채팅에는 붙이지 마세요.

### 입력은 호출한 그대로 남기세요

`pressDir`는 **이미 눌려 있어도 매번 초기 이동을 다시 겁니다.** "눌린 상태면 생략" 같은 압축을 하면 결과가 달라져 재현이 어긋납니다. 호출 횟수 자체가 판에 남습니다.

```js
function press(dir) {
  game.pressDir(dir);
  recorder.push(dir > 0 ? ReplayAction.MoveRight : ReplayAction.MoveLeft, true);
}
```

---

## 6. 상대 판 읽기

받은 스트림을 `BoardMirror`에 그대로 먹이면 상대 판이 재현됩니다. 스택 높이를 실시간으로 볼 수 있어 타깃 선택이 정확해집니다.

```js
import { BoardMirror } from "@fetris/engine/mirror";

// match-start의 sim으로 상대마다 하나씩 세운다
for (const s of msg.sim) {
  if (s.id === myId) continue;
  mirrors.set(s.id, new BoardMirror({
    rule: config.rule,
    handling: s.handling ?? config.handling,
    seed: s.seed,
    simRate: config.simRate,
    attackMul: config.attackMul,
  }));
}

// 받은 대로 먹이고
if (msg.t === "sync") mirror.feed(msg.upto, msg.keys, msg.ige);
if (msg.t === "full") mirror.keyframe(msg.frame, msg.snap);
if (msg.t === "board") mirror.snapshot(msg.snap);   // 옛 클라이언트 호환

// 매 틱 한 번씩 굴린다
mirror.advance();

// 이제 mirror.game이 그 사람 판이다
mirror.game.board.highestRow();
```

`BoardMirror` 요약:

| 멤버 | 설명 |
|---|---|
| `feed(upto, keys?, garbage?)` | 받은 입력을 이어 붙인다 |
| `keyframe(frame, snap)` | 크게 벌어졌을 때만 상태를 갈아끼운다 |
| `snapshot(snap)` | 스냅샷만 보내는 상대 — 시뮬을 돌리지 않는다 |
| `advance()` | 받은 데까지 진행. 진행한 프레임 수를 돌려준다 |
| `game` | 그 사람의 `Game` |
| `behind` | 아직 따라잡지 못한 프레임 수 |

---

## 7. 공격

공격은 **sender-authoritative**입니다. 상쇄하고 남은 공격을 직접 타깃에게 보냅니다.

```js
for (const e of game.events) {
  if (e.type === EventType.Attack && e.cells?.length) {
    const target = pickTarget();
    if (target) send({ t: "relay-to", targetId: target,
                       msg: { t: "attack", holes: [...e.cells] } });
  }
}
game.events.length = 0;
```

받을 때는 로컬 보드에 쌓고 기록기에도 남깁니다.

```js
if (msg.t === "attack") {
  game.receiveGarbage({ holes: msg.holes });
  recorder.pushGarbage(msg.holes);   // 빼먹으면 재현이 어긋난다
}
```

TETR.IO식 4전략(random / even / elims / payback)이 관례입니다. 수동 타깃은 없습니다.

---

## 8. 계획 고스트 (표시 전용)

봇이 **"이렇게 놓을 생각이다"** 를 자기 보드에 반투명 미노로 띄우는 기능입니다. AI가 가방 단위로 세운 계획을 사람이 눈으로 볼 수 있게 하는 표시 전용 오버레이입니다.

**게임 상태가 아닙니다.** 시뮬레이션·판정·리플레이 검증 어디에도 끼지 않으므로 결정론을 건드리지 않습니다.

```jsonc
// 통째로 올리기
{ "t": "plan", "set": [
  { "id": "p0", "piece": 6, "rot": 0, "x": 3, "y": 38, "alpha": 0.55 }
] }

// 하나만 추가·갱신 (같은 id면 덮어씀)
{ "t": "plan", "add": [{ "id": "p1", "piece": 1, "rot": 1, "x": 8, "y": 34 }] }

// 골라서 지우기
{ "t": "plan", "remove": ["p0"] }

// 전부 지우기
{ "t": "plan", "set": [] }
```

`relay`로 감싸지 **않습니다.** 제어 메시지로 그냥 보냅니다 — 상태를 서버가 들고 있기 때문입니다.

| 필드 | 필수 | 설명 |
|---|---|---|
| `id` | △ | 이 고스트의 이름. `remove`로 지우려면 반드시 필요 |
| `piece` | ✓ | 1=I, 2=J, 3=L, 4=O, 5=S, 6=T, 7=Z |
| `rot` | ✓ | 0=Spawn, 1=Right, 2=Two, 3=Left |
| `x` | ✓ | 보드 열 |
| `y` | ✓ | 보드 행. **버퍼 포함** — 엔진과 같은 좌표계 |
| `alpha` | | 0~1. 뒤쪽 계획을 흐리게 할 때 |

한 사람이 동시에 띄울 수 있는 개수는 **32개**입니다.

서버가 알아서 해주는 것:

1. **놓인 자리는 자동으로 걷힙니다.** 계획한 칸이 보드에서 전부 메워지면 사라집니다.
2. **판이 끝나면 정리됩니다.** 시작할 때도 한 번 비웁니다.
3. **나가면 사라집니다.**

바뀔 때마다 방 전체에 알립니다.

```jsonc
{ "t": "plan-state", "playerId": "p3xk1a", "ghosts": [ /* 현재 상태 전부 */ ] }
```

관전자와 리플레이에서도 그대로 보입니다. **매 프레임 보내지 마세요** — 바뀔 때만 보내면 됩니다.

---

## 9. 리플레이 제출 (선택)

서버가 중계하면서 입력 스트림을 받아 적기 때문에, `sync`만 제대로 흘려보내면 봇이 아무것도 제출하지 않아도 그 판은 이미 60Hz로 재생됩니다.

제출을 하면 거기에 **최종 상태 지문**이 붙어, 파일을 열 때 온전한지 확인할 수 있고 서버가 부정 여부를 대조할 수 있습니다.

```js
send({
  t: "replay",
  matchId,          // match-start에서 받은 값
  seed,             // sim에서 받은 내 시드
  handling,         // 내가 쓴 감도
  frames,           // 시뮬레이션한 총 프레임 수 (recorder.frame)
  keys,             // recorder.keys
  garbage,          // recorder.garbage
  fingerprint,      // fingerprint(game)
  stats,            // { piecesPlaced, lines, attack }
});
```

한 번만 보내면 됩니다 — 서버가 방에 흘려줍니다. 지문이 어긋나면 `replay-mismatch`가 돌아오지만 **자동 제재는 없습니다**(오탐으로 정상 참가자를 쫓아내는 쪽이 더 나쁩니다).

---

## 10. 순단 복귀

`joined`에 실려 온 `session` 토큰을 들고 있다가, 연결이 끊기면 새 소켓에서 복귀할 수 있습니다.

```js
send({ t: "resume", token: session, lastSeenId });
```

판이 도는 중이면 서버가 자리를 **15초** 잡아둡니다. 그 안에 돌아오면 같은 자리로 앉고, 끊긴 사이 놓친 메시지를 다시 받습니다. 자리가 이미 정리됐으면 `resume-failed`가 오고, 그때는 새로 입장해야 합니다.

`lastSeenId`는 서버 메시지에 붙어 오는 `id` 중 마지막으로 받은 값입니다.

---

## 11. 흔한 실수

- **시드를 직접 뽑는다** → `match-start`의 `sim`에서 자기 것을 쓰세요.
- **받은 가비지를 기록에서 빼먹는다** → 정상 플레이도 전부 `replay-mismatch`가 됩니다.
- **`pressDir` 호출을 압축한다** → 결과가 달라집니다. 호출한 그대로 남기세요.
- **`upto`를 실제보다 앞서 부른다** → 남의 화면에서 내 판이 어긋납니다.
- **키프레임을 스트림보다 먼저 보낸다** → 미러가 지나간 입력을 다시 먹습니다.
- **`simRate`를 무시한다** → `update(1)` 한 번과 `update(0.5)` 두 번은 조각 잠금 타이밍이 달라 다른 상태로 끝납니다.
- **`game.events`를 안 비운다** → 계속 쌓여 같은 공격을 반복해 보냅니다.
- **관전 상태에서 판을 연다** → `match-start.players`에 자기 id가 있는지 먼저 확인하세요.

---

## 12. 에러 코드

| reason | 뜻 |
|---|---|
| `bot-auth-failed` | 토큰이 틀렸거나 없습니다 |
| `bot-path-required` | `/bot` 경로로 붙어야 하는 동작입니다 |
| `invalid-ticket` | 티켓이 만료됐거나 없습니다 (초대 후 15초) |
| `already-in-room` | 이미 방에 앉은 소켓입니다 |
| `room-not-found` | 방 코드가 틀렸습니다 |
| `room-full` | 참가 정원이 찼습니다 (관전은 언제나 가능) |
| `not-in-lobby` | 매치 진행 중이라 할 수 없는 동작입니다 |
| `not-host` | 호스트만 할 수 있는 동작입니다 |
| `no-bot-available` | 대기 중인 러너가 없습니다 |
| `bot-join-timeout` | 초대 후 봇이 제때 착석하지 않았습니다 |
| `replay-mismatch` | 제출한 기록이 재현 결과와 어긋납니다 |
| `resume-failed` | 복귀할 자리가 이미 정리됐습니다 |

---

## 13. 환경 변수 (참조 러너 기준)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `FETRIS_WS_URL` | `ws://localhost:8787` | 릴레이 주소 |
| `FETRIS_BOT_TOKEN` | — | 접속 토큰 |
| `FETRIS_BOT_NAME` | `Example Bot` | 러너 이름 |
| `FETRIS_BOT_CAPACITY` | `2` | 동시에 맡을 봇 수 (1~16) |
| `FETRIS_BOT_PPS` | `2` | 초당 놓는 조각 수 |
| `FETRIS_BOT_PLAN` | `3` | 화면에 띄울 계획 길이 (0 = 끄기) |

방 채팅으로도 조절합니다: `!bot pps 2.5` · `!bot target elims` · `!bot plan 4` · `!bot status` · `!bot help`
