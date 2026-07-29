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
        border: `2px solid ${urgent ? FUNKY.danger : "var(--funky-line)"}`,
        background: "var(--funky-surface)",
        boxShadow: "4px 4px 0 rgba(0,0,0,0.25)",
        fontWeight: 800,
        fontSize: "0.8rem",
      }}
    >
      <span
        style={{
          display: "inline-block",
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: urgent ? FUNKY.danger : FUNKY.green,
        }}
      />
      <span style={{ letterSpacing: "0.06em" }}>ROOM {room.code}</span>
      <span style={{ opacity: 0.65 }}>{label}</span>
      <button
        onClick={onReturn}
        style={{
          border: "2px solid var(--funky-line)",
          background: urgent ? FUNKY.danger : "transparent",
          color: urgent ? "#fff" : "inherit",
          fontWeight: 900,
          fontSize: "0.72rem",
          padding: "3px 8px",
          cursor: "pointer",
        }}
      >
        돌아가기
      </button>
    </div>
  );
}
