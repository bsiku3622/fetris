# FETRIS

Funky UI 감성의 오프라인 테트리스. Tetr.io급 메커니즘에 그 이상의 최적화를 더했습니다.

크림 바탕 위 네온 · 검정 테두리 · 하드 그림자의 neo-brutalist 룩, 그리고 끊김 없는 60fps 플레이.

## 특징

- **Tetr.io급 메커니즘** — SRS+ / SRS-X / 180° 킥테이블, 7-bag, 홀드, All-Mini+ 스핀 판정(T-spin 3-corner + immobile), 시즌2 **B2B Surge** 시스템, 곱셈형 콤보.
- **정밀 핸들링** — DAS / ARR / DCD / SDF를 서브프레임 정밀도로. safelock, cancel-DAS 토글. 전역 설정.
- **모드** — 40 Lines(스프린트) · Blitz(2분) · Zen(무한) · Marathon · 4-Wide(4칸 보드 Zen) · Combo(4칸 콤보 트레이너) · Custom.
- **풍부한 설정** — Handling · Controls(키 리매핑) · Graphics · Audio · Performance · Rules(모드별 룰). Tetr.io 설정을 폭넓게 반영.
- **성능** — 60Hz 고정 timestep 시뮬 ↔ rAF 렌더 분리(주사율 독립·결정론적), hot loop 할당 0(Int8Array·object pool), 게임 중 React 리렌더 0. simRate(60/120/240)·frame cap·보간 설정 가능.
- **사운드** — Web Audio 100% 합성 SFX + 컨볼루션 리버브(공간감) · 마스터 리미터. 모드별 BGM(로비/신나는/신비로운/점증/칠). **외부 오디오 에셋이 전혀 없어 저작권 걱정 없이 자유 배포 가능(CC0).**

## 기술 스택

| 영역 | 기술 |
|---|---|
| 게임 엔진 | TypeScript + Canvas2D (순수, 결정론적) |
| UI 셸 | React 18 (메뉴/설정만, 게임 중엔 비관여) |
| 디자인 | `@studio-baeks/funky-ui` (neo-brutalist) |
| 번들러 | Vite 6 |
| 데스크탑 | Tauri v2 (네이티브 WebView — Electron 아님, .app 약 3MB) |
| 테스트 | Vitest (엔진 단위) + Playwright (E2E/성능) |

데스크탑에 Electron이 아닌 **Tauri(네이티브 WKWebView)** 를 쓴 이유: macOS에서 Electron/Chromium 컴포지터로 인한 마이크로 스터터를 구조적으로 피하고, 번들 크기를 50배가량 줄이기 위함입니다.

## 개발

```bash
npm install
npm run dev        # 웹 dev 서버 (http://localhost:1420)
npm test           # 엔진 단위 테스트
npm run typecheck
```

## 빌드 — 3가지 모두

### 웹

```bash
npm run build      # → dist/ (정적 호스팅)
npm run preview
```

`main` 브랜치 push 시 GitHub Actions(`.github/workflows/web.yml`)가 GitHub Pages로 배포합니다.

### 데스크탑 (Windows .exe / macOS .app / Linux)

로컬 빌드(현재 OS 대상)에는 [Rust](https://rustup.rs/)가 필요합니다.

```bash
npm run tauri:build
# macOS  → src-tauri/target/release/bundle/{macos/Fetris.app, dmg/*.dmg}
# Windows→ src-tauri/target/release/bundle/{msi,nsis}/*
# Linux  → src-tauri/target/release/bundle/{appimage,deb}/*
```

Tauri는 크로스 컴파일이 안 되므로, 3-OS 모두를 위한 빌드는 **GitHub Actions 매트릭스**(`.github/workflows/desktop.yml`)가 처리합니다 — `v*` 태그 push 또는 수동 실행 시 macOS(Intel+ARM) · Windows · Linux 바이너리를 빌드해 아티팩트로 올립니다.

## 조작 (기본값)

| 동작 | 키 |
|---|---|
| 이동 | ← → |
| 소프트/하드 드롭 | ↓ / Space |
| 회전 CW / CCW / 180 | ↑·X / Z·Ctrl / A |
| 홀드 | C · Shift |
| 다시하기 / 일시정지 | R / Esc |

모든 키는 설정 → Controls에서 변경할 수 있습니다.

## 프로젝트 구조

```
src/
  engine/     # 결정론적 코어 (board, srs, spin, scoring, handling, game, loop, modes, input)
  render/     # Canvas 렌더러 · 파티클/액션텍스트 이펙트 · 테마
  audio/      # Web Audio 합성 SFX
  app/        # GameSession(글루), 설정 store, App 라우팅
  ui/         # React 화면 (Menu/Game/Settings) + funky 커스텀 컨트롤
tests/        # Vitest 엔진 테스트
src-tauri/    # Tauri v2 데스크탑 셸
docs/         # Tetr.io 메커니즘·설정 레퍼런스
```

## 라이선스

[MIT](LICENSE). 모든 사운드는 코드로 합성되어 외부 오디오 에셋이 없습니다 — 자유롭게 사용·수정·재배포할 수 있습니다.
