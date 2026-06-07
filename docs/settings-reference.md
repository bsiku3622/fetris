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
