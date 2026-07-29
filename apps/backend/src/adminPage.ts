// ============================================================================
// 관리 페이지 HTML — 의존성 없이 문자열로 들고 있는다(빌드에 자산 복사 단계가
// 생기지 않도록). funky 톤(크림 배경 · 검정 테두리 · 하드 그림자)에 맞췄다.
// ============================================================================

export const ADMIN_PAGE = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fetris 봇 토큰</title>
<style>
  :root {
    --bg: #fff5d1; --surface: #ffffff; --sunken: #fff0b8;
    --ink: #222222; --muted: #6f6a52; --line: #000000;
    --pink: #ff4eba; --yellow: #ffd500; --sky: #00c8ff;
    --green: #00c22a; --danger: #ff3b3b; --purple: #7828c8;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 16px 64px;
    background: var(--bg); color: var(--ink);
    font-family: Pretendard, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-weight: 700; line-height: 1.5;
  }
  .wrap { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 1.6rem; font-weight: 900; letter-spacing: -0.02em; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: .85rem; margin-bottom: 24px; }
  .card {
    background: var(--surface); border: 2px solid var(--line);
    box-shadow: 4px 4px 0 var(--line); padding: 16px; margin-bottom: 20px;
  }
  .card h2 {
    font-size: .75rem; font-weight: 900; letter-spacing: .12em;
    text-transform: uppercase; margin: 0 0 12px; color: var(--muted);
  }
  label { display: block; font-size: .78rem; margin-bottom: 4px; }
  input {
    width: 100%; padding: 10px 12px; border: 2px solid var(--line);
    background: var(--sunken); font: inherit; font-size: .95rem;
  }
  input:focus { outline: none; background: #fff; box-shadow: inset 2px 2px 0 rgba(0,0,0,.12); }
  .row { display: flex; gap: 10px; flex-wrap: wrap; }
  .row > * { flex: 1 1 180px; }
  button {
    border: 2px solid var(--line); background: var(--surface); color: var(--ink);
    font: inherit; font-weight: 900; padding: 10px 16px; cursor: pointer;
    box-shadow: 3px 3px 0 var(--line); transition: transform .06s, box-shadow .06s;
  }
  button:hover { transform: translate(1px,1px); box-shadow: 2px 2px 0 var(--line); }
  button:active { transform: translate(3px,3px); box-shadow: 0 0 0 var(--line); }
  button.primary { background: var(--yellow); }
  button.danger { background: var(--danger); color: #fff; padding: 6px 10px; box-shadow: 2px 2px 0 var(--line); font-size: .72rem; }
  .token-list { display: flex; flex-direction: column; gap: 8px; }
  .token {
    display: flex; align-items: center; gap: 10px;
    border: 2px solid var(--line); background: var(--sunken); padding: 10px 12px;
  }
  .token .who { font-weight: 900; }
  .token .meta { color: var(--muted); font-size: .76rem; font-weight: 700; }
  .token .val { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .74rem; color: var(--muted); }
  .token .spacer { margin-left: auto; }
  .empty { color: var(--muted); font-size: .85rem; padding: 8px 0; }
  .issued {
    border: 2px solid var(--line); background: var(--green); color: #fff;
    padding: 14px; margin-bottom: 20px; box-shadow: 4px 4px 0 var(--line);
  }
  .issued .label { font-size: .72rem; letter-spacing: .1em; text-transform: uppercase; opacity: .85; }
  .issued code {
    display: block; margin: 8px 0; padding: 10px; background: rgba(0,0,0,.25);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: .9rem; word-break: break-all; font-weight: 700;
  }
  .issued .hint { font-size: .76rem; opacity: .9; }
  .issued button { background: rgba(255,255,255,.9); font-size: .74rem; padding: 6px 10px; }
  .runner { display: flex; align-items: center; gap: 8px; border: 2px dashed var(--line); padding: 8px 12px; margin-bottom: 6px; font-size: .84rem; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); }
  .dot.busy { background: var(--pink); }
  .err { border: 2px solid var(--danger); background: #fff; color: var(--danger); padding: 10px 14px; margin-bottom: 16px; }
  .foot { color: var(--muted); font-size: .74rem; text-align: center; margin-top: 32px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Fetris 봇 토큰</h1>
  <div class="sub">VPN 내부에서만 열리는 관리 페이지입니다. 발급·폐기는 즉시 반영되고 릴레이 재시작이 필요 없습니다.</div>

  <div id="err" class="err" style="display:none"></div>
  <div id="issued" class="issued" style="display:none">
    <div class="label">발급된 토큰 — 이 화면에서만 볼 수 있습니다</div>
    <code id="issued-token"></code>
    <div class="hint">봇 주인에게 전달하세요. 창을 닫으면 다시 볼 수 없습니다.</div>
    <div style="margin-top:10px"><button onclick="copyToken()">복사</button></div>
  </div>

  <div class="card">
    <h2>새 토큰 발급</h2>
    <div class="row">
      <div>
        <label for="owner">소유자</label>
        <input id="owner" placeholder="예: 친구A" autocomplete="off">
      </div>
      <div>
        <label for="label">메모 (선택)</label>
        <input id="label" placeholder="예: 연습 상대" autocomplete="off">
      </div>
    </div>
    <div style="margin-top:12px"><button class="primary" onclick="issue()">발급하기</button></div>
  </div>

  <div class="card">
    <h2>발급된 토큰</h2>
    <div id="tokens" class="token-list"><div class="empty">불러오는 중…</div></div>
  </div>

  <div class="card">
    <h2>지금 붙어 있는 러너</h2>
    <div id="runners"><div class="empty">불러오는 중…</div></div>
  </div>

  <div class="foot">fetris-admin · <span id="relay"></span></div>
</div>

<script>
let lastToken = "";

function showErr(msg) {
  const el = document.getElementById("err");
  el.textContent = msg;
  el.style.display = msg ? "block" : "none";
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || (res.status + " " + res.statusText));
  }
  return res.json();
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function load() {
  showErr("");
  try {
    const data = await api("/api/tokens");
    const box = document.getElementById("tokens");
    if (data.tokens.length === 0) {
      box.innerHTML = '<div class="empty">아직 발급한 토큰이 없습니다.</div>';
    } else {
      box.innerHTML = data.tokens.map((t) =>
        '<div class="token">' +
          '<span class="who">' + esc(t.owner) + '</span>' +
          (t.label ? '<span class="meta">' + esc(t.label) + '</span>' : '') +
          '<span class="val">' + esc(t.masked) + '</span>' +
          '<span class="spacer"></span>' +
          '<button class="danger" onclick="revoke(\\'' + esc(t.id) + '\\', \\'' + esc(t.owner) + '\\')">폐기</button>' +
        '</div>'
      ).join("");
    }
  } catch (e) {
    showErr("토큰 목록을 불러오지 못했습니다: " + e.message);
  }

  try {
    const data = await api("/api/runners");
    document.getElementById("relay").textContent = "릴레이 " + data.relay;
    const box = document.getElementById("runners");
    if (!data.runners || data.runners.length === 0) {
      box.innerHTML = '<div class="empty">대기 중인 러너가 없습니다.</div>';
    } else {
      box.innerHTML = data.runners.map((r) => {
        const busy = r.active >= r.capacity;
        return '<div class="runner">' +
          '<span class="dot' + (busy ? " busy" : "") + '"></span>' +
          '<b>' + esc(r.name) + '</b>' +
          '<span class="meta">' + esc(r.owner) + (r.label ? " · " + esc(r.label) : "") + '</span>' +
          '<span class="spacer" style="margin-left:auto"></span>' +
          '<span class="meta">' + r.active + "/" + r.capacity + '</span>' +
        '</div>';
      }).join("");
    }
  } catch (e) {
    document.getElementById("runners").innerHTML =
      '<div class="empty">릴레이에 연결할 수 없습니다 (' + esc(e.message) + ')</div>';
  }
}

async function issue() {
  const owner = document.getElementById("owner").value.trim();
  const label = document.getElementById("label").value.trim();
  if (!owner) { showErr("소유자를 입력해주세요."); return; }
  try {
    const data = await api("/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner, label }),
    });
    lastToken = data.token;
    document.getElementById("issued-token").textContent = data.token;
    document.getElementById("issued").style.display = "block";
    document.getElementById("owner").value = "";
    document.getElementById("label").value = "";
    load();
  } catch (e) {
    showErr("발급 실패: " + e.message);
  }
}

async function revoke(id, owner) {
  if (!confirm(owner + "의 토큰을 폐기할까요?\\n그 봇은 즉시 접속할 수 없게 됩니다.")) return;
  try {
    await api("/api/tokens/" + encodeURIComponent(id), { method: "DELETE" });
    load();
  } catch (e) {
    showErr("폐기 실패: " + e.message);
  }
}

function copyToken() {
  navigator.clipboard.writeText(lastToken).then(
    () => showErr(""),
    () => showErr("클립보드 복사에 실패했습니다. 직접 선택해 복사해주세요."),
  );
}

load();
setInterval(load, 10000);
</script>
</body>
</html>`;
