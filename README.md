# fetris-be

Fetris 1대1 대전용 WebSocket 릴레이 서버. 방 코드 기반 매칭 + sender-authoritative 메시지 중계만 담당하는 가벼운 서버입니다. 게임 로직/판정은 클라이언트가 처리하고, 서버는 두 플레이어 사이에서 메시지를 그대로 전달합니다.

## 빠른 시작

```bash
npm install
npm run dev      # tsx watch, 기본 :8787
# 또는
npm run build && npm start
```

`PORT` 환경변수로 포트 변경, `GET /health` 로 헬스체크(`ok`).

## 프로토콜

클라이언트 → 서버(`ClientControl`):

| 메시지 | 설명 |
|---|---|
| `{ t: "create" }` | 방 생성 → `{ t: "created", code }` 응답 |
| `{ t: "join", code }` | 방 입장 → `{ t: "joined", ... }` / `{ t: "error", reason }` |
| `{ t: "relay", msg }` | 상대에게 게임 메시지 중계 |
| `{ t: "leave" }` | 방 나가기 |

서버 → 클라이언트(`ServerControl`): `created`, `joined`, `peer-joined`, `peer-left`, `error`, `relay`.

`relay`의 `msg`(게임 메시지)는 서버가 해석하지 않습니다. 방은 최대 2명이고, 누구든 나가면 방이 정리되며 상대에게 `peer-left`가 전달됩니다. 30초 주기 ping으로 죽은 연결을 정리합니다.

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
