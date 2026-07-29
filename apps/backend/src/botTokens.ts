import { readFileSync, statSync } from "node:fs";

// ============================================================================
// 봇 토큰 스토어 — 토큰마다 소유자를 붙여 "누가 올린 봇인지" 구분한다.
//
// 파일이 지정되면 봇 경로(`/bot`)에 토큰이 필수가 되고, 지정하지 않으면
// 예전처럼 열려 있다(로컬 개발 편의). 즉 공개 서버에서는 파일을 두는 것이
// 사실상의 기본값이다.
//
// 토큰을 추가하거나 폐기할 때 서버를 재시작할 필요가 없도록 mtime을 보고
// 자동으로 다시 읽는다. 봇 연결은 드물어서 이 정도 검사는 부담이 없다.
// ============================================================================

export interface BotTokenEntry {
  /** 러너가 `?token=`으로 제시하는 값 */
  token: string;
  /** 이 토큰으로 붙은 봇의 주인 — 로스터와 러너 목록에 표시된다 */
  owner: string;
  /** 선택 메모(어떤 봇인지) */
  label?: string;
}

export interface BotTokenFile {
  tokens: BotTokenEntry[];
}

export interface TokenLookup {
  owner: string;
  label?: string;
}

export class BotTokenStore {
  private path: string | null;
  /** 단일 토큰 방식(FETRIS_BOT_TOKEN) 호환 — 소유자는 이름 없는 기본값 */
  private legacyToken: string;
  private byToken = new Map<string, TokenLookup>();
  private lastMtimeMs = -1;
  private lastCheckMs = 0;

  constructor(opts: { path?: string; legacyToken?: string } = {}) {
    this.path = opts.path?.trim() || null;
    this.legacyToken = opts.legacyToken?.trim() || "";
    if (this.path) this.reload(true);
  }

  /** 토큰 검사를 해야 하는 서버인지 */
  get required(): boolean {
    return !!this.path || this.legacyToken.length > 0;
  }

  /** 등록된 토큰 수(운영 확인용) */
  get size(): number {
    this.maybeReload();
    return this.byToken.size + (this.legacyToken ? 1 : 0);
  }

  /**
   * 토큰을 검증한다. 토큰이 필요 없는 서버면 익명 소유자로 통과시킨다.
   * 반환값이 null이면 거부.
   */
  verify(token: string): TokenLookup | null {
    if (!this.required) return { owner: "anonymous" };
    const t = token.trim();
    if (!t) return null;
    if (this.legacyToken && t === this.legacyToken) return { owner: "server" };
    this.maybeReload();
    return this.byToken.get(t) ?? null;
  }

  /** 파일이 바뀌었으면 다시 읽는다(최대 초당 1회 검사) */
  private maybeReload(): void {
    if (!this.path) return;
    const now = Date.now();
    if (now - this.lastCheckMs < 1000) return;
    this.lastCheckMs = now;
    try {
      const mtime = statSync(this.path).mtimeMs;
      if (mtime !== this.lastMtimeMs) this.reload(false);
    } catch {
      // 파일이 사라졌다면 기존 토큰을 유지한다 — 실수로 전원 차단되는 것보다 낫다
    }
  }

  private reload(initial: boolean): void {
    if (!this.path) return;
    try {
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as BotTokenFile;
      const next = new Map<string, TokenLookup>();
      for (const entry of parsed.tokens ?? []) {
        const token = String(entry.token ?? "").trim();
        if (!token) continue;
        next.set(token, {
          owner: String(entry.owner ?? "unknown").slice(0, 24),
          label: entry.label ? String(entry.label).slice(0, 40) : undefined,
        });
      }
      this.byToken = next;
      this.lastMtimeMs = statSync(this.path).mtimeMs;
      console.log(`[fetris-be] 봇 토큰 ${next.size}개 로드 (${this.path})`);
    } catch (err) {
      if (initial) {
        console.warn(`[fetris-be] 봇 토큰 파일을 읽을 수 없습니다 (${this.path}):`, err);
      }
      // 읽기 실패 시 기존 맵을 유지한다(빈 맵으로 덮으면 전원이 튕긴다)
    }
  }
}
