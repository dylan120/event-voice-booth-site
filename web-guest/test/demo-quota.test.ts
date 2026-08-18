import { beforeEach, describe, expect, it } from "vitest";
import worker, { type Env } from "../src/worker";

const secret = "demo-quota-test-secret-with-at-least-32-bytes";
const hostID = "11111111-1111-4111-8111-111111111111";

/** 使用内存模型验证路由的关键安全契约：三条硬上限、录音 UUID 幂等和认证边界。 */
function fakeDB() {
  let used = 0; let lastRecordingID: string | null = null; const counted = new Set<string>();
  const statement = (sql: string, bindings: unknown[] = []): any => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => {
      if (sql.includes("SELECT auth_epoch,auth_session_expires_at")) return bindings[0] === hostID ? { auth_epoch: 0, auth_session_expires_at: 4_102_444_800 } : null;
      if (sql.includes("SELECT apple_subject")) return bindings[0] === hostID ? { apple_subject: "apple-subject-a", subscription_expires_at: null } : null;
      if (sql.includes("SELECT counted_at FROM demo_message_claims")) return counted.has(String(bindings[1])) ? { counted_at: 1 } : null;
      if (sql.includes("SELECT message_count FROM demo_quotas")) return used ? { message_count: used } : null;
      return null;
    },
    run: async () => {
      if (sql.startsWith("UPDATE demo_quotas SET message_count")) {
        const recordingID = String(bindings[0]);
        if (used < 3 && !counted.has(recordingID)) { used += 1; lastRecordingID = recordingID; }
      }
      if (sql.startsWith("UPDATE demo_message_claims SET counted_at")) {
        const recordingID = String(bindings[2]);
        if (lastRecordingID === recordingID) counted.add(recordingID);
      }
      if (sql.startsWith("DELETE FROM demo_message_claims")) return { meta: { changes: 1 } };
      return { meta: { changes: 1 } };
    }
  });
  return { prepare: (sql: string) => statement(sql), batch: async (items: any[]) => Promise.all(items.map(item => item.run())) } as unknown as D1Database;
}

async function accessToken() {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const issuedAt = Math.floor(Date.now() / 1000);
  const signed = `${encode({ alg: "HS256", typ: "EVB" })}.${encode({ iss: "event-voice-booth", aud: "host-api", hostID, epoch: 0, iat: issuedAt, exp: issuedAt + 900 })}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${signed}.${Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed))).toString("base64url")}`;
}

function environment(): Env { return { DB: fakeDB(), AUTH_TOKEN_SECRET: secret, DEMO_QUOTA_SECRET: "demo-quota-test-secret-with-at-least-32-bytes" } as unknown as Env }
async function claim(env: Env, recordingID: string, token?: string) {
  return worker.fetch(new Request("https://worker.test/v1/host/demo-quota/claims", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ recordingID }) }), env);
}

describe("Host demo quota", () => {
  beforeEach(() => { globalThis.crypto ??= require("node:crypto").webcrypto; });

  it("同一 Host 最多领取三条，且同一录音重试不会重复扣减", async () => {
    const env = environment(); const token = await accessToken();
    const ids = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"];
    for (const recordingID of ids) expect((await claim(env, recordingID, token)).status).toBe(201);
    expect((await claim(env, ids[2], token)).status).toBe(200);
    expect((await claim(env, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", token)).status).toBe(409);
  });

  it("无 bearer 不能读取或消耗免费额度", async () => {
    expect((await claim(environment(), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).status).toBe(401);
  });
});
