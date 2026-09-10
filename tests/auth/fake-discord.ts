// A fake Discord `GET /oauth2/@me`, with a request log and per-token
// scripted answers -- the test double `resolveBearer`'s injected
// `fetchImpl` talks to (09 §2.2; 20-spark.md S3s widens this from
// `/users/@me`, mirroring tests/import/fake-upstream.ts's pattern: a plain
// function implementing the Fetch API shape, no `cloudflare:test`
// `fetchMock`).
import type { FetchImpl } from "../../src/import/upstream";

const DEFAULT_APP_ID = "app-default";

export type DiscordAnswer =
  // `app_id` defaults to `DEFAULT_APP_ID` so every existing call site that
  // doesn't care about it (most of the suite) keeps working unchanged.
  | { kind: "ok"; id: string; username: string; global_name: string | null; app_id?: string }
  // 20-spark.md S3s: a 200 whose grant lacks the `identify` scope --
  // `application` present, no `user` key at all.
  | { kind: "no-identify"; app_id?: string }
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
    if (answer.kind === "no-identify") {
      return new Response(
        JSON.stringify({ application: { id: answer.app_id ?? DEFAULT_APP_ID }, scopes: [], expires: "2099-01-01T00:00:00.000Z" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        application: { id: answer.app_id ?? DEFAULT_APP_ID },
        scopes: ["identify"],
        expires: "2099-01-01T00:00:00.000Z",
        user: { id: answer.id, username: answer.username, global_name: answer.global_name },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}
