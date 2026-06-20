import { invoke } from "@tauri-apps/api/core";

// ============================================================================
// LAN 릴레이 제어 — Tauri 데스크탑에서만 동작(웹 빌드에선 isTauri()=false).
// 호스트가 lanStart()로 내장 릴레이 서버를 띄우면, 같은 USB/Thunderbolt 브리지
// 망의 게스트가 ws://<호스트IP>:<port> 로 붙어 대전한다. 서버 코드는 src-tauri/src/lan.rs.
// ============================================================================

export interface LanInfo {
  running: boolean;
  port: number;
  addrs: string[]; // 로컬 IPv4 목록(게스트가 입력할 호스트 IP 후보)
}

/** 현재 Tauri(데스크탑) 웹뷰에서 실행 중인지. 웹/모바일 브라우저면 false. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** LAN 릴레이 서버 시작. port 미지정 시 기본 포트(점유 시 임의 포트로 폴백). */
export function lanStart(port?: number): Promise<LanInfo> {
  return invoke<LanInfo>("lan_start", { port });
}

/** LAN 릴레이 서버 중지(모든 연결 종료). */
export function lanStop(): Promise<void> {
  return invoke<void>("lan_stop");
}

/** 현재 서버 상태 + 로컬 IPv4 주소 목록. */
export function lanStatus(): Promise<LanInfo> {
  return invoke<LanInfo>("lan_status");
}

/** 표시·연결용으로 가장 그럴듯한 호스트 IP를 고른다.
 *  USB/Thunderbolt 브리지는 보통 169.254.x(링크로컬) 또는 사설망 IP로 잡힌다.
 *  사설망(192.168/10/172.16–31) > 링크로컬(169.254) > 기타 순으로 우선. */
export function pickHostAddr(addrs: string[]): string | null {
  if (!addrs.length) return null;
  const isPrivate = (a: string) =>
    a.startsWith("192.168.") ||
    a.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(a);
  const linkLocal = (a: string) => a.startsWith("169.254.");
  return (
    addrs.find(isPrivate) ?? addrs.find(linkLocal) ?? addrs[0]
  );
}

export interface DiscoveredHost {
  ip: string;
  port: number;
}

/** UDP 비콘을 ~1.5초 수신해 같은 망의 LAN 호스트를 자동 탐색한다. */
export function lanDiscover(): Promise<DiscoveredHost[]> {
  return invoke<DiscoveredHost[]>("lan_discover");
}
