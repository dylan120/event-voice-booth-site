import { beforeEach, describe, expect, it } from "vitest";
import worker, { type Env } from "../src/worker";

const secret = "account-delete-test-secret-with-at-least-32-bytes";
const hostA = "11111111-1111-4111-8111-111111111111";
const hostB = "22222222-2222-4222-8222-222222222222";

type Fixture = {
  unfinished?: boolean;
  sessions?: string[];
  submissions?: Array<{ audio_key: string; photo_manifest: string }>;
  capabilities?: Array<{ id: string; session_id: string }>;
};

/** 只实现删除账号路径实际使用的 D1 契约，并记录语句以验证对象级删除边界。 */
function fakeDB(fixture: Fixture) {
  const executed: Array<{ sql: string; bindings: unknown[] }> = [];
  const statement = (sql: string, bindings: unknown[] = []): any => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => {
      executed.push({ sql, bindings });
      if (sql.includes("SELECT auth_epoch,auth_session_expires_at")) {
        return bindings[0] === hostA ? { auth_epoch: 0, auth_session_expires_at: 4_102_444_800 } : null;
      }
      if (sql.includes("SELECT 1 FROM sessions")) return fixture.unfinished ? { 1: 1 } : null;
      return null;
    },
    all: async () => {
      executed.push({ sql, bindings });
      if (sql.includes("SELECT id FROM sessions")) return { results: (fixture.sessions ?? []).map(id => ({ id })) };
      if (sql.includes("SELECT audio_key,photo_manifest")) return { results: fixture.submissions ?? [] };
      if (sql.includes("SELECT id,session_id FROM capabilities")) return { results: fixture.capabilities ?? [] };
      return { results: [] };
    },
    run: async () => {
      executed.push({ sql, bindings });
      if (sql.includes("UPDATE hosts SET deleting_at")) {
        return { meta: { changes: fixture.unfinished ? 0 : 1 } };
      }
      return { meta: { changes: 1 } };
    }
  });
  return {
    db: {
      prepare: (sql: string) => statement(sql),
      batch: async (statements: any[]) => Promise.all(statements.map(statement => statement.run()))
    } as unknown as D1Database,
    executed
  };
}

async function accessToken(hostID = hostA) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const issuedAt = Math.floor(Date.now() / 1000);
  const signed = `${encode({ alg: "HS256", typ: "EVB" })}.${encode({ iss: "event-voice-booth", aud: "host-api", hostID, epoch: 0, iat: issuedAt, exp: issuedAt + 900 })}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed))).toString("base64url");
  return `${signed}.${signature}`;
}

function environment(fixture: Fixture = {}) {
  const database = fakeDB(fixture);
  const deletedObjects: string[][] = [];
  const env = {
    DB: database.db,
    MEDIA: { delete: async (keys: string | string[]) => { deletedObjects.push(Array.isArray(keys) ? keys : [keys]); } },
    AUTH_TOKEN_SECRET: secret
  } as unknown as Env;
  return { env, deletedObjects, executed: database.executed };
}

async function remove(env: Env, token?: string, body?: string) {
  return worker.fetch(new Request("https://worker.test/v1/auth/account", {
    method: "DELETE",
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
    body
  }), env);
}

describe("DELETE /v1/auth/account", () => {
  beforeEach(() => { globalThis.crypto ??= require("node:crypto").webcrypto; });

  it("没有 bearer 时返回 401 且不执行删除", async () => {
    const { env, executed, deletedObjects } = environment();
    expect((await remove(env)).status).toBe(401);
    expect(executed).toHaveLength(0);
    expect(deletedObjects).toHaveLength(0);
  });

  it("仍有 live Session 或 ready 投稿时返回 409，且不部分删除", async () => {
    const { env, executed, deletedObjects } = environment({ unfinished: true });
    const response = await remove(env, await accessToken());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "account_cleanup_required" });
    expect(executed.some(item => item.sql.startsWith("DELETE"))).toBe(false);
    expect(deletedObjects).toHaveLength(0);
  });

  it("只删除 bearer 所属 Host 的对象与记录", async () => {
    const session = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const { env, executed, deletedObjects } = environment({
      sessions: [session],
      submissions: [{ audio_key: `sessions/${session}/audio.m4a`, photo_manifest: JSON.stringify([{ key: `sessions/${session}/photo.jpg`, bytes: 1, sha256: "a".repeat(64) }]) }],
      capabilities: [{ id: "capability-a", session_id: session }]
    });
    expect((await remove(env, await accessToken())).status).toBe(204);
    expect(deletedObjects.flat()).toEqual(expect.arrayContaining([
      `sessions/${session}/audio.m4a`,
      `sessions/${session}/photo.jpg`,
      `quarantine/${session}/capability-a`
    ]));
    const allBindings = executed.flatMap(item => item.bindings);
    expect(allBindings).toContain(hostA);
    expect(allBindings).not.toContain(hostB);
    expect(executed.filter(item => item.sql.startsWith("DELETE")).every(item => !item.sql.includes(hostB))).toBe(true);
  });

  it("拒绝带请求体的删除，避免含糊契约", async () => {
    const { env, executed, deletedObjects } = environment();
    expect((await remove(env, await accessToken(), "{}" )).status).toBe(401);
    expect(executed.some(item => item.sql.startsWith("DELETE"))).toBe(false);
    expect(deletedObjects).toHaveLength(0);
  });
});
