import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri는 고정 포트를 기대한다. 웹 단독 빌드와 데스크탑 빌드가 같은 설정을 공유한다.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
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
