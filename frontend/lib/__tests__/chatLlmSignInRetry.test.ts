// chatLlm AND A 401 FROM THE CHAT FUNCTION (C8): ONE session refresh, ONE
// retry — never a loop.
//
// The Edge Function answers 401 sign_in_required when the bearer does not
// verify, and for that request it calls no model and meters nothing. A
// signed-in reader's token can simply have expired between the app reading
// the session and the function checking it: lib/cfoApi.chatLlm asks Supabase
// for a fresh session once and sends the request once more. A second 401 is
// the answer — the chat renders "sign in again" from its code
// (components/cfo/chat/__tests__/chatRefusal.test.tsx).
//
// WHAT IT REDS ON (TC-11): no retry after a refresh that worked; a retry
// without a refresh, or with the old token; MORE than one retry or refresh
// (a loop against a function that keeps saying no); a retry for a signed-out
// caller (nothing to refresh), for an aborted request, or for any refusal
// that is not a 401 (the cap and the meter must not be asked twice).
//
// WHAT IT CANNOT SEE: supabase-js's own refresh (mocked here — the session
// object is the seam), and the function's side of the 401 (chatLlmGuard).

import { beforeEach, describe, expect, it, vi } from "vitest";

let session: { access_token: string; user: { id: string } } | null = null;
const getSession = vi.fn(async () => ({ data: { session } }));
const refreshSession = vi.fn(async (): Promise<{ data: { session: typeof session }; error: unknown }> => ({ data: { session }, error: null }));
vi.mock("@/lib/supabase", () => ({
  getSupabase: () => ({ auth: { getSession, refreshSession } }),
  currentOrgId: async () => null,
}));

const { cfoApi, CfoApiError } = await import("@/lib/cfoApi");

const fetchMock = vi.fn();
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const REFUSED_401 = () => json(401, { error: "sign_in_required", detail: { code: "sign_in_required", message: "Sign in to use Ask CFO AI." } });
const ANSWER = () => json(200, { answer: "the answer", model: "claude-opus-4-7", usage: null });
const REQ = { messages: [{ role: "user" as const, content: "q" }], mode: "workspace" as const };

const bearers = () => fetchMock.mock.calls.map((c) => (c[1] as RequestInit).headers as Record<string, string>).map((h) => h.Authorization ?? null);

beforeEach(() => {
  session = { access_token: "t1", user: { id: "0f0e0d0c-0000-4000-8000-00000000c4a7" } };
  getSession.mockClear();
  refreshSession.mockReset();
  refreshSession.mockImplementation(async () => {
    session = { access_token: "t2", user: session!.user };
    return { data: { session }, error: null };
  });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  document.documentElement.lang = "en";
});

describe("chatLlm — a 401 from the function while signed in", () => {
  it("POSITIVE CONTROL: an answered call is one request to the function, with the session's bearer", async () => {
    fetchMock.mockResolvedValueOnce(ANSWER());
    const r = await cfoApi.chatLlm(REQ);
    expect(r.answer).toBe("the answer");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/functions\/v1\/chat-llm$/);
    expect(bearers()).toEqual(["Bearer t1"]);
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it("401, then a fresh session: ONE refresh, ONE retry with the NEW token — and the answer", async () => {
    fetchMock.mockResolvedValueOnce(REFUSED_401()).mockResolvedValueOnce(ANSWER());
    const r = await cfoApi.chatLlm(REQ);
    expect(r.answer).toBe("the answer");
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bearers()).toEqual(["Bearer t1", "Bearer t2"]);
    // The same request, both times.
    expect((fetchMock.mock.calls[1][1] as RequestInit).body).toBe((fetchMock.mock.calls[0][1] as RequestInit).body);
  });

  it("401 again after the refresh: it stops — two requests, one refresh, and the 401 with its code is thrown", async () => {
    fetchMock.mockImplementation(async () => REFUSED_401());
    const err = await cfoApi.chatLlm(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CfoApiError);
    expect((err as InstanceType<typeof CfoApiError>).status).toBe(401);
    expect(((err as InstanceType<typeof CfoApiError>).detail as { code: string }).code).toBe("sign_in_required");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  it("a refresh that fails (or returns no session): no retry", async () => {
    for (const failing of [
      async () => ({ data: { session: null }, error: new Error("refresh_token_not_found") }),
      async () => ({ data: { session: null }, error: null }),
      async () => { throw new Error("network"); },
    ]) {
      fetchMock.mockReset();
      fetchMock.mockImplementation(async () => REFUSED_401());
      refreshSession.mockReset();
      refreshSession.mockImplementation(failing as never);
      const err = await cfoApi.chatLlm(REQ).catch((e: unknown) => e);
      expect((err as InstanceType<typeof CfoApiError>).status).toBe(401);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(refreshSession).toHaveBeenCalledTimes(1);
    }
  });

  it("signed out: nothing to refresh — one request, no refresh, the 401 is thrown", async () => {
    session = null;
    fetchMock.mockImplementation(async () => REFUSED_401());
    const err = await cfoApi.chatLlm(REQ).catch((e: unknown) => e);
    expect((err as InstanceType<typeof CfoApiError>).status).toBe(401);
    expect(bearers()).toEqual([null]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it.each([
    [429, { error: "chat_cap_reached", detail: { code: "chat_cap_reached", kind: "daily_cap_reached" } }],
    [503, { error: "metering_unavailable", detail: { code: "metering_unavailable" } }],
    [503, { error: "auth_unavailable", detail: { code: "auth_unavailable" } }],
    [400, { error: "invalid_request", detail: "messages is required" }],
    [500, { detail: "boom" }],
  ])("a %i is never retried and never refreshes: the cap and the meter are asked once", async (status, body) => {
    fetchMock.mockImplementation(async () => json(status as number, body));
    const err = await cfoApi.chatLlm(REQ).catch((e: unknown) => e);
    expect((err as InstanceType<typeof CfoApiError>).status).toBe(status);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it("an aborted request is not retried", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async () => { controller.abort(); return REFUSED_401(); });
    await cfoApi.chatLlm(REQ, controller.signal).catch(() => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it("a network failure is not a 401: thrown as it is, once", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const err = await cfoApi.chatLlm(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it("the request names the reader's language (for the function's own sentence) and changes nothing else", async () => {
    fetchMock.mockImplementation(async () => ANSWER());
    await cfoApi.chatLlm(REQ);
    document.documentElement.lang = "ro";
    await cfoApi.chatLlm(REQ);
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));
    expect(bodies[0]).toEqual({ ...REQ, language: "en" });
    expect(bodies[1]).toEqual({ ...REQ, language: "ro" });
  });
});
