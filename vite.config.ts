import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Tauri는 고정 포트를 기대한다. 웹 단독 빌드와 데스크탑 빌드가 같은 설정을 공유한다.
const host = process.env.TAURI_DEV_HOST;

// funky-ui tokens.css는 Pretendard를 jsdelivr CDN에서 @import 한다(Vite는 external @import를
// 출력에 그대로 남긴다). 오프라인(비행기) 동작을 위해 최종 번들 CSS에서 그 줄을 제거한다 —
// 폰트는 src/styles/fonts.css가 로컬 woff2로 번들한다. dev 서버에는 영향 없음(개발 중엔 인터넷 가정).
function stripFunkyCdnFont(): Plugin {
  const CDN_IMPORT =
    /@import\s*(?:url\(\s*)?["']https:\/\/cdn\.jsdelivr\.net[^"')]*pretendard[^"')]*["']\s*\)?\s*;?/gi;
  return {
    name: "strip-funky-cdn-font",
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type === "asset" && file.fileName.endsWith(".css") && typeof file.source === "string") {
          file.source = file.source.replace(CDN_IMPORT, "");
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [stripFunkyCdnFont(), react()],
  // 상대 경로 base: Tauri의 file:// 로딩과 정적 호스팅 둘 다에서 동작
  base: "./",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2022",
    minify: "esbuild",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
        },
      },
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
