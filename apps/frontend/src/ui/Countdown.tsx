import { useEffect, useState } from "react";
import { GO_MS } from "../app/countdown";

// ============================================================================
// Countdown — 판이 열리기 전 3·2·1·GO!.
//
// 무대 전체에 **하나만** 뜬다. 보드마다 그리면 미러가 스트림만큼 뒤에 있어서
// 내 보드와 상대 보드에 다른 숫자가 뜬다 — 같은 판을 보는데 시작 시각이 서로
// 다른 것처럼 보인다.
//
// 숫자는 세션이 엔진 프레임에서 뽑아 넘겨준다. 여기서 따로 시간을 재지 않으므로
// 프레임률이 흔들려도, simRate가 달라도 판이 실제로 열리는 순간과 어긋나지 않는다.
// ============================================================================

export function Countdown({ n }: { n: number }) {
  /** GO!는 잠깐 떴다가 스스로 걷힌다 — 판이 시작됐는데 계속 떠 있으면 방해가 된다 */
  const [gone, setGone] = useState(false);
  useEffect(() => {
    setGone(false);
    if (n !== 0) return;
    const t = setTimeout(() => setGone(true), GO_MS);
    return () => clearTimeout(t);
  }, [n]);

  if (n < 0 || gone) return null;
  const go = n === 0;
  return (
    <div className="fx-count" aria-hidden>
      {/* key로 갈아끼워야 숫자마다 등장 애니메이션이 다시 돈다 */}
      <b key={n} className={go ? "is-go" : ""}>
        {go ? "GO!" : n}
      </b>
    </div>
  );
}
