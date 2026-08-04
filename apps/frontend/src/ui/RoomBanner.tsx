import { FUNKY } from "../render/theme";
import type { RoomSession } from "../app/roomSession";

// ============================================================================
// RoomBanner — 방에 붙어 있는 동안 어느 화면에서든 떠 있는 상태 표시.
// 대기 중에 Zen을 하다가도 방이 어떻게 돌아가는지 알 수 있어야 하고,
// 매치가 시작되면 여기 표시가 바뀌기 전에 App이 대전 화면으로 소환한다.
// ============================================================================

export function RoomBanner({ room, onReturn }: { room: RoomSession; onReturn: () => void }) {
  const state = room.state;
  if (!state) return null;

  const alive = state.players.filter((p) => p.alive).length;
  const label =
    state.phase === "playing"
      ? `대전 중 · ${alive}명 생존`
      : state.phase === "results"
        ? "결과 확인 중"
        : `대기실 · ${state.players.length}명`;

  const urgent = state.phase === "playing";

  return (
    <div
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 12px",
        borderRadius: 999,
        border: `1px solid ${urgent ? FUNKY.danger : "var(--funky-line)"}`,
        background: "rgba(26,20,44,0.92)",
        backdropFilter: "blur(8px)",
        boxShadow: "0 6px 22px rgba(0,0,0,0.42)",
        fontWeight: 800,
        fontSize: "0.8rem",
        color: "var(--funky-ink)",
      }}
    >
      {/* 판이 도는 중이면 붉게 깜빡여 돌아갈 곳이 있다는 걸 알린다 */}
      <span
        style={{
          display: "inline-block",
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: urgent ? FUNKY.danger : FUNKY.green,
          boxShadow: `0 0 10px ${urgent ? FUNKY.danger : FUNKY.green}`,
          animation: urgent ? "fx-pulse 1s ease-in-out infinite" : undefined,
        }}
      />
      <span style={{ letterSpacing: "0.08em" }}>ROOM {room.code}</span>
      <span style={{ color: "var(--funky-ink-muted)" }}>{label}</span>
      <button
        onClick={onReturn}
        style={{
          borderRadius: 999,
          border: `1px solid ${urgent ? "transparent" : "var(--funky-line)"}`,
          background: urgent ? FUNKY.danger : "transparent",
          color: urgent ? "#fff" : "var(--funky-ink)",
          fontFamily: "inherit",
          fontWeight: 900,
          fontSize: "0.72rem",
          padding: "4px 10px",
          cursor: "pointer",
        }}
      >
        돌아가기
      </button>
    </div>
  );
}
