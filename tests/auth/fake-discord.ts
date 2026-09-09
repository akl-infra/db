// A fake Discord `/users/@me`, with a request log and per-token scripted
// answers -- the test double `resolveBearer`'s injected `fetchImpl` talks
// to (09 §2.2, mirroring tests/import/fake-upstream.ts's pattern: a plain
// function implementing the Fetch API shape, no `cloudflare:test`
// `fetchMock`).
import type { FetchImpl } from "../../src/import/upstream";

export type DiscordAnswer =
  | { kind: "ok"; id: string; username: string; global_name: string | null }
  | { kind: "status"; status: number; retryAfter?: string }
  | { kind: "throw" }
  | { kind: "malformed" }; // 200 with a non-JSON body

export interface LoggedRequest {
  url: string;
  authorization: string | undefined;
}

export class FakeDiscord {
  readonly requestLog: LoggedRequest[] = [];
  private answers = new Map<string, DiscordAnswer>(); // token -> scripted answer
  private defaultAnswer: DiscordAnswer = { kind: "status", status: 401 };

  setAnswer(token: string, answer: DiscordAnswer): void {
    this.answers.set(token, answer);
  }

  setDefaultAnswer(answer: DiscordAnswer): void {
    this.defaultAnswer = answer;
  }

  readonly fetchImpl: FetchImpl = async (url, init) => {
    const authorization = init.headers["Authorization"];
    this.requestLog.push({ url, authorization });

    const token = authorization?.replace(/^Bearer /, "") ?? "";
    const answer = this.answers.get(token) ?? this.defaultAnswer;

    if (answer.kind === "throw") throw new Error("fake discord: network error");
    if (answer.kind === "malformed") {
      return new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } });
    }
    if (answer.kind === "status") {
      const headers: Record<string, string> = {};
      if (answer.retryAfter !== undefined) headers["Retry-After"] = answer.retryAfter;
      return new Response(JSON.stringify({ message: "error" }), { status: answer.status, headers });
    }
    return new Response(
      JSON.stringify({ id: answer.id, username: answer.username, global_name: answer.global_name }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}
