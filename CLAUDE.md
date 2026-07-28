# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 저장소 구성

npm workspaces 기반 **단일 저장소**입니다. 루트에 통합 스크립트가 있고, 개별 작업은 `-w <패키지>`로 지정하거나 해당 디렉토리에서 실행합니다.

- `packages/engine` (`@fetris/engine`) — 게임 코어. **순수 TS·결정론적**이며 클라이언트와 서버가 공유합니다. 서버 사이드 리플레이 검증이 이 공유를 전제로 하므로, 비결정적 요소(`Math.random`, 시간 의존, 엔진 구현 재량 함수)를 넣지 마세요.
- `apps/frontend` (`fetris`) — 게임 클라이언트. Canvas2D 렌더 + React 18 셸, Vite 6 번들, Tauri v2 데스크탑 패키징.
- `apps/backend` (`fetris-be`) — 대전 릴레이 서버. `ws` 의존 + `@fetris/engine`(검증용). 방·매치 진행은 서버가 관리하고, 게임 페이로드는 해석 없이 중계합니다.

engine은 **frontend에서 소스로, backend에서 빌드 산출물로** 참조됩니다 — frontend는 `vite.config.ts`의 alias와 `tsconfig.json`의 paths로 `packages/engine/src`를 직접 보므로 엔진을 고쳐도 재빌드 없이 HMR이 됩니다. backend는 `exports` 맵을 통해 `dist`를 쓰므로 **backend를 빌드·실행하기 전에 `npm run build:engine`이 선행돼야 합니다.**

## 명령

### 루트 (워크스페이스 전체)

```bash
npm run dev          # 프론트 dev 서버 (http://localhost:1420)
npm run dev:server   # 릴레이 서버 dev (기본 :8787)
npm run build        # engine → frontend → backend 순차 빌드
npm run build:engine # engine만 빌드 (backend 실행 전 필요)
npm test             # 세 패키지 테스트 전부
npm run typecheck    # 세 패키지 타입체크 전부
```

### 개별 패키지

```bash
npm test -w @fetris/engine       # 엔진 단위 테스트 (packages/engine/tests)
npm test -w fetris               # 대전 통합 테스트 (apps/frontend/tests)
npm test -w fetris-be            # 방·중계·봇 엔드포인트 테스트
npm run tauri:dev -w fetris      # Tauri 데스크탑 dev (Rust 필요)
npm run tauri:build -w fetris    # 네이티브 번들 (현재 OS만 — 크로스 컴파일 불가)

# 단일 테스트는 해당 패키지 디렉토리에서
cd packages/engine && npx vitest run tests/engine.test.ts
cd packages/engine && npx vitest run -t "<이름>"
```

데스크탑 3-OS 빌드와 웹 CI는 루트 `.github/workflows/`의 Actions가 처리합니다(로컬에서 재현 불필요).

## 아키텍처 핵심

### 엔진과 React의 엄격한 분리 (가장 중요한 설계 제약)

게임 플레이 중에는 **React가 전혀 관여하지 않습니다.** React는 메뉴/설정 화면만 그리고, 게임이 시작되면 `GameSession`/`VersusSession`이 React 밖에서 루프·렌더·사운드·입력을 직접 구동합니다. HUD 갱신은 state가 아니라 **콜백**(`onHud`)으로 전달해 게임 중 리렌더를 0으로 유지합니다.

이 분리는 성능 목표(60fps, hot loop 할당 0)의 근간이므로 깨지 않도록 주의합니다. 게임 루프 안에서 React state·setState를 끌어들이거나, hot path(`Board`, `Game.update`)에서 객체를 새로 할당하지 마세요. `Board`는 `Int8Array` 그리드, 이펙트는 object pool을 씁니다.

### 결정론적 코어 ↔ 렌더 분리

`engine/game.ts`의 `Game`은 **그리기를 모릅니다.** `update(dtFrames, input)`로 한 시뮬 스텝만 진행하고, 일어난 일을 `GameEvent` 버퍼(`EventType`)에 쌓습니다. 렌더러·사운드·이펙트는 이 이벤트 버퍼를 드레인해 반응합니다. 새 게임 동작을 추가할 때는 이 패턴(Game이 이벤트 emit → 세션이 소비)을 따릅니다.

`engine/loop.ts`의 `GameLoop`는 **고정 timestep 시뮬 ↔ rAF 렌더**를 분리합니다. 엔진 시간 단위는 항상 60Hz 프레임(`dtFrames`)이라 `simRate`(60/120/240)나 디스플레이 주사율과 무관하게 메커니즘 수치가 일관됩니다. 메커니즘 상수를 다룰 때 이 "60Hz 프레임 기준" 가정을 항상 유지하세요.

### packages/engine 레이어 (순수 TS)

`board`(그리드/충돌/라인클리어) · `srs`(SRS+/SRS-X/180° 킥테이블) · `spin`(T-spin 3-corner + immobile 판정) · `scoring`(B2B Surge, 곱셈 콤보) · `handling`(DAS/ARR/DCD/SDF) · `randomizer`(7-bag) · `garbage`(대전 가비지/상쇄) · `pieces` · `finesse` · `modes` · `input` · `config`(기본값/룰셋) · `types`.

`input.ts`만 DOM(키 이벤트)에 의존하고 나머지는 전부 DOM 비의존입니다. 서버는 순수 모듈만 import하므로 barrel(index) 파일을 만들지 마세요 — subpath(`@fetris/engine/game`)로만 가져다 씁니다. 패키지 내부 상대 import는 Node ESM 규칙상 **`.js` 확장자가 필요**합니다(`./types.js`). 반대로 소비자 쪽은 확장자 없이 씁니다(`@fetris/engine/types`).

### 화면 흐름 (apps/frontend/src/app/)

`App.tsx`가 `Screen` 유니온(`menu`/`game`/`settings`/`versus`)으로 단일 화면을 전환합니다. 설정은 `store.ts`에서 localStorage(`fetris.settings.v1`)에 깊은 병합으로 영속화됩니다 — 신규 설정 필드를 추가할 땐 깊은 병합 호환을 깨지 않도록 기본값을 `config.ts`/각 모듈 DEFAULT에 함께 넣습니다.

- `GameSession.ts` — 싱글플레이 1판 컨트롤러(루프+렌더+사운드+입력+모드 통합).
- `VersusSession.ts` / `VersusMatch.ts` — 대전판. `VersusMatch`는 렌더/입력 비의존 헤드리스 코어이고, `VersusSession`이 UI를 붙입니다.

### 대전 네트워킹

**매치 진행은 서버가 소유하고, 게임 내용물은 클라이언트가 소유합니다.** 서버는 방 상태(`lobby → countdown → playing → results`), 참가자 명단·역할·준비, 라스트맨 스탠딩 순위, 누적 승수를 관리합니다. 보드·가비지·시드로 무엇이 나오는지는 모릅니다. 클라이언트가 매치 흐름을 스스로 판단하게 만들지 마세요 — 이전 구조가 그래서 3인 이상에서 무너졌습니다.

- 클라 `net/transport.ts`의 `Transport` 추상화에만 `VersusMatch`가 의존합니다 → 실제 WebSocket이든 로컬 루프백이든 동일 동작(서버 없이 테스트·로컬 대전 가능).
- 공격은 **sender-authoritative**: 타깃을 TETR.IO식 4전략(random/even/elims/payback)으로 골라 `relay-to`로 보냅니다. 수동 타깃은 없습니다.
- 보드 스냅샷은 **두 단계**로 나갑니다 — 방 전체에 저빈도(`SNAP_AMBIENT_FRAMES`, 썸네일용), 나를 크게 보고 있는 사람에게만 고빈도(`SNAP_FOCUS_FRAMES`). 인원의 제곱으로 불어나는 트래픽을 막기 위한 구조이니, 전체 브로드캐스트 주기를 올리지 마세요.
- KO돼도 세션은 살아 있습니다. 로컬 보드만 잠기고 관전으로 넘어가며, 승패 판정은 서버가 합니다.
- 프로토콜 변경 시 클라 `net/protocol.ts`와 backend `src/protocol.ts`를 함께 맞춰야 합니다.
- 봇은 서버가 실행하지 않습니다. 외부 봇 러너가 `/bot` 경로로 붙어 대기하고, 호스트의 `add-bot` 요청에 서버가 티켓을 발급해 초대하면 참가자 슬롯에 착석합니다.

### 리플레이 검증

매치가 끝나면 클라이언트가 프레임 단위 원시 입력 로그와 최종 상태 지문을 제출하고, 서버가 `@fetris/engine`으로 재현해 대조합니다(`packages/engine/src/replay.ts`).

이 구조가 성립하려면 **엔진이 완전히 결정론적**이어야 합니다. `Math.random`·시간 API·엔진 구현 재량 함수(`Math.pow`/`Math.log` 등)를 엔진에 들이지 마세요 — `determinism.test.ts`가 소스를 스캔해 막고 있습니다.

또 하나, **simRate가 결과를 바꿉니다.** `update(1)` 한 번과 `update(0.5)` 두 번은 조각 잠금 타이밍이 달라 다른 상태로 끝납니다. 그래서 `MatchConfig`에 simRate와 핸들링을 함께 싣고 검증에서 그대로 씁니다. 자세한 내용은 `apps/backend/README.md`의 "리플레이 검증" 절에 있습니다.

## 작업 시 주의

- 사운드는 **100% Web Audio 코드 합성**입니다(`audio/sound.ts`). 외부 오디오 에셋을 추가하지 마세요 — CC0 자유 배포가 프로젝트 전제입니다.
- 설정 항목을 추가/변경할 땐 `apps/frontend/docs/settings-reference.md`도 함께 갱신합니다.
- 루트 `.claude/.mode`는 `/discuss`·`/discuss-done` 스킬로만 변경합니다(직접 수정 금지). 스킬이 셸의 현재 디렉토리 기준으로 파일을 만드니, 호출 전에 작업 위치가 저장소 루트인지 확인하세요.
