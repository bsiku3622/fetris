import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/fonts.css";
import "@studio-baeks/funky-ui/styles.css";
import "./styles/app.css";
import { App } from "./app/App";

// 캔버스 렌더러는 게임 중 "Pretendard"를 직접 사용한다(DOM 미경유). 폰트를 미리 로드해
// 첫 프레임부터 적용되게 한다(로드 전엔 system 폴백으로 그려지는 깜빡임 방지).
if (typeof document !== "undefined" && document.fonts) {
  void document.fonts.load('900 16px "Pretendard"');
  void document.fonts.load('900 16px "Pretendard Variable"');
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
