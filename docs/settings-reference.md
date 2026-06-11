# Fetris 설정 페이지 체크리스트 (Tetr.io 기준)

> 출처: 실제 TETR.IO config 덤프 + 공식 FAQ. 단위는 frame(1/60s) 기준, ms 토글 제공.

## 1. Handling (전역)
- **DAS** `frames` 0~20, 기본 10
- **ARR** `frames` 0~5, 기본 2 (0=즉시 텔레포트)
- **DCD** (DAS Cut Delay) `frames` 0~5, 기본 0
- **SDF** (Soft Drop Factor) `×` 5~41(41=∞), 기본 6
- **Prevent Accidental Hard Drops** (safelock) toggle, 기본 on — 하드드롭 직후 N프레임 하드드롭 잠금
- **Cancel DAS On Direction Change** (cancel) toggle, 기본 off
- frame/ms 단위 토글, TEST 영역

> 주의: Tetr.io 핸들링 토글은 safelock·cancel 2개뿐. "DAS Cut Direction/Diagonal Priority/IRS·IHS"는 Tetr.io에 없음(타 클론 용어).

## 2. Controls (키바인딩, 전부 리매핑)
Move Left/Right, Soft Drop, Hard Drop, Rotate CW/CCW/180, Hold, Retry, Pause/Exit.
복수 키 매핑 허용. 기본: ←→ ↓ Space, Z(CCW) ↑/X(CW) A(180) C/Shift(Hold) R(retry) Esc.

UI는 두 그룹으로 분리:
- **게임 키**(`GAME_ACTIONS`) — Move L/R, Soft/Hard Drop, Rotate CW/CCW/180, Hold. 프리셋이 다루는 대상.
- **시스템 키**(`SYSTEM_ACTIONS`) — Retry, Pause/Exit. 프리셋과 무관(토글해도 보존).

프리셋(KEYMAP_PRESETS):
- **클래식** — ←→ 이동, ↓ Soft, Space Hard, Z/Ctrl(CCW) ↑·X(CW) A(180), C/Shift(Hold)
- **WASD** — A/D 이동, W Soft, S Hard, ←(CCW) →(CW) ↑(180), Shift(Hold)
- **IOP** — L/' 이동, P Soft, ; Hard, O(CCW) [(CW) /(180), Shift(Hold)

프리셋 동작(게임 키에만 적용):
- 활성 표시는 현재 키맵에서 역산 — 프리셋의 게임 키를 모두 포함하면 그 버튼이 활성(여러 프리셋 합치기 가능).
- 비활성 프리셋 클릭 → 게임 키를 현재 키맵에 합침. 활성 프리셋 다시 클릭 → 그 프리셋의 게임 키를 전부 제거(단독 선택이던 프리셋을 끄면 게임 키가 비워짐). 시스템 키는 어느 쪽이든 그대로 유지.
- **커스텀 프리셋** — "현재 키맵 저장"으로 지금 키맵을 이름 붙여 저장(`settings.customPresets`에 영속). 칩 모서리 ×로 삭제.

## 3. Graphics
- Ghost(shadow) opacity 0~1 + Colored Shadow toggle
- Grid opacity, Board opacity, Background opacity
- Particles 0~1
- Screen Shake (shakiness) 0~1, Bounciness 0~1
- Bloom 0~1, Chroma 0~1
- Board Spin(T-spin 회전 연출) toggle
- Zoom, Flash on big clear
- Graphics preset OFF/LOW/MED/HIGH/ULTRA
- **Frame rate limit** (성능: 1x/2x/3x/4x 주사율 배수 또는 무제한)
- Power Save, Low-res mode

## 4. Audio
- Disable all toggle
- Music volume 0~1 (기본 0.45)
- SFX volume 0~1 (기본 0.4)
- Stereo 0~1
- 토글: attack sounds, oof, next piece sounds
- Sound Pack 선택(단순화)

## 5. Gameplay
- NEXT count 0~7 (기본 5)
- Hold on/off
- 통계 표시(PPS/APM/finesse/시간)
- Countdown on/off
- Auto-retry (40L/Blitz)

## 6. Custom/모드 룰 (모드별 RuleSet)
gravity, gravity increase/margin, lock delay, kickset(SRS+/SRS/SRS-X/none),
spin bonus(none/t-spins/all-mini/all-mini+/all), bag type(7/14/classic/pairs/random),
board width/height, allow hard drop, infinite movement/hold, b2b mode(surge/chaining/none),
garbage multiplier/cap/speed.
