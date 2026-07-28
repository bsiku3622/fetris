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
board width/height, allow hard drop, infinite movement/hold, b2b mode(surge/chaining/none).

### 가비지(대전) 관련
- **garbageMultiplier** — 보낼 공격 배수(상쇄 후 적용). 기본 1.
- **garbageCap** — 한 번의 락에서 보드에 올라오는 최대 줄 수. 기본 8(Tetr.io). 초과분은 버리지 않고 다음 락에 이어 투하.
- **garbageSpeed** — 받은 가비지가 올라오기까지 대기 프레임(예고+상쇄 시간). 기본 20.
- **garbageHoleMode** — `clean`(기본): 한 공격 안은 한 컬럼으로 깔끔하되 **공격마다 구멍 컬럼이 바뀜**(Tetr.io "change on attack"). `cheese`: 줄마다 랜덤(최대 치즈).
- **garbageMessiness** `0~1` — 한 공격 **안에서** 줄별로 구멍이 흔들릴 확률(within-attack). 기본 0(한 공격은 깔끔). 공격 간 컬럼 변화는 항상 일어남.
- **perfectClearDamage** — 퍼펙트 클리어 추가 공격. 기본 5(Tetr.io 시즌2).
- **clutch** — 톱아웃 직전 라인 클리어로 생존(스폰을 버퍼 위로 밀어 올림). 기본 on(Tetr.io 시즌2). 끄면 즉시 게임오버.

**시즌2 기본 동작(설정 없이 항상 적용):**
- 받은 가비지 도달 시간이 공격 크기에 비례(1-2줄 20f / 3-5줄 30f / 6+줄 40f).
- **Surge 방출은 3개의 공격으로 쪼개** 발사(부분 상쇄 가능).
- **오프너 더블 상쇄** — 첫 14피스 동안 들어온 가비지가 내 공격보다 많으면 2배로 상쇄.
- **clean-clear +1** — 들어온 가비지를 상쇄한 퀘드/스핀은 +1 추가 공격(곱 안 함).
- 퍼펙트 클리어는 B2B로 카운트.

## 7. 오프라인 / LAN 직결 (데스크탑)
- 단일플레이는 서버 없이 100% 오프라인 동작(폰트도 로컬 번들 — `src/styles/fonts.css`).
- 대전은 데스크탑 앱에서 **LAN 직결**(USB/Thunderbolt/이더넷)로 인터넷 없이 가능. 설정·문제 해결은 `docs/lan-play.md` 참고.
