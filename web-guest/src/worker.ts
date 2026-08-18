import { verifyAttestation } from "@bradford-tech/supabase-integrity-attest/attestation";
import { verifyAssertion } from "@bradford-tech/supabase-integrity-attest/assertion";
import { Environment, SignedDataVerifier } from "@studium-ignotum/app-store-server-library";

export interface Env { DB: D1Database; MEDIA: R2Bucket; GUEST_ORIGIN: string; HOST_ORIGIN: string; MAX_EVENT_BYTES: string; MAX_AUDIO_BYTES: string; MAX_PHOTO_BYTES: string; SESSION_TTL_SECONDS: string; MAX_ACTIVE_SESSIONS: string; MAX_SUBMISSIONS_PER_SESSION: string; HOST_REGISTRATION_ENABLED: string; APPLE_HOST_AUTH_ENABLED: string; APP_ATTEST_APP_ID: string; APP_ATTEST_DEVELOPMENT: string; APP_STORE_BUNDLE_ID: string; APP_APPLE_ID: string; AUTH_TOKEN_SECRET?: string; DEMO_QUOTA_SECRET?: string; IP_HASH_SALT?: string }
type Session = { id: string; host_id: string; public_slug: string; state: "live" | "revoked" | "expired"; revoke_version: number; expires_at: number; max_bytes: number; used_bytes: number; submission_count: number; subscription_expires_at?: number | null }
type AttestedHost = { id: string; public_key: ArrayBuffer | Uint8Array; app_attest_key_id: string | null; app_attest_public_key_pem: string | null; app_attest_sign_count: number; subscription_expires_at?: number | null }
type RateLimit = { scope: string; maximum: number; windowSeconds: number }
type UploadLease = { id: string; sessionID: string }
type Capability = { id: string; session_id: string; revoke_version: number; media_kind: "audio" | "photo"; max_bytes: number; expires_at: number; consumed_at: number | null; upload_state: "issued" | "uploading" | "uploaded" | "finalizing" | "finalized"; state: Session["state"]; current_revoke_version: number; session_expires: number }
type StoredPhoto = { key: string; bytes: number; sha256: string }
type Submission = { id: string; session_id: string; state: "uploading" | "ready" | "claimed" | "acked" | "discarded"; audio_key: string; audio_bytes: number; audio_sha256: string; photo_manifest: string; guest_receipt: string | null; created_at: number; expires_at: number; host_id: string }
type AppleIdentity = { sub: string; aud: string | string[]; iss: string; exp: number; iat?: number; nonce?: string; email?: string }
const appleIdentityFailureCode = (error: unknown) => {
  const reason = error instanceof Error ? error.message : "verification";
  switch (reason) {
  case "invalid_identity_nonce": return "apple_identity_nonce_failed";
  case "invalid_identity_audience": return "apple_identity_audience_failed";
  case "invalid_identity_signature": return "apple_identity_signature_failed";
  case "apple_jwk_missing": return "apple_identity_key_failed";
  case "apple_jwks_unavailable": return "apple_identity_keys_unavailable";
  case "invalid_identity_claims": return "apple_identity_claims_failed";
  default: return "apple_identity_token_failed";
  }
};
type HostAccess = { iss: "event-voice-booth"; aud: "host-api"; hostID: string; epoch: number; iat: number; exp: number }
const limits = {
  // Apple 登录入口在任何密码学验证和外部 JWKS 请求前按脱敏 IP 摘要限速。
  appleChallengeIP: { maximum: 60, windowSeconds: 3_600 },
  appleLoginIP: { maximum: 20, windowSeconds: 3_600 },
  refreshIP: { maximum: 120, windowSeconds: 3_600 },
  refreshFailureToken: { maximum: 8, windowSeconds: 3_600 },
  // App Attest 只能证明 App 实例，不能阻止真实设备被自动化；Host 操作还须限速。
  hostSensitive: { maximum: 120, windowSeconds: 3_600 },
  hostChallenge: { maximum: 180, windowSeconds: 3_600 },
  bootstrapIP: { maximum: 30, windowSeconds: 60 },
  capabilityIP: { maximum: 12, windowSeconds: 60 },
  capabilitySession: { maximum: 100, windowSeconds: 3_600 },
  uploadIP: { maximum: 12, windowSeconds: 60 },
  uploadSession: { maximum: 120, windowSeconds: 3_600 },
  finalizeIP: { maximum: 8, windowSeconds: 60 },
  finalizeSession: { maximum: 100, windowSeconds: 3_600 }
} as const;
const json = (body: unknown, status = 200, extraHeaders: HeadersInit = {}) => new Response(JSON.stringify(body), { status, headers: securityHeaders({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders }) });
const empty = (status: number) => new Response(null, { status, headers: securityHeaders({ "cache-control": "no-store" }) });
function securityHeaders(extra: HeadersInit = {}): Headers {
  const h = new Headers(extra); h.set("x-content-type-options", "nosniff"); h.set("x-frame-options", "DENY"); h.set("referrer-policy", "no-referrer"); h.set("permissions-policy", "camera=(), geolocation=(), payment=(), usb=()"); h.set("content-security-policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'; img-src 'self' blob:; media-src 'self' blob:; script-src 'self'; style-src 'self'; worker-src 'none'"); return h
}
const now = () => Math.floor(Date.now() / 1000);
const id = () => crypto.randomUUID();
const bytes = (value: string) => new TextEncoder().encode(value);
const b64 = (data: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(data))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
/** URL-safe base64 解码；函数声明可供上方的固定 Apple 根证书常量安全调用。 */
function fromB64(value: string) { return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0)); }
function safeFromB64(value: string): Uint8Array | null { try { return /^[A-Za-z0-9_-]+$/.test(value) ? fromB64(value) : null } catch { return null } }
/** D1 BLOB 会按运行时以 ArrayBuffer 或 Uint8Array 返回；统一成无复制视图给 WebCrypto。 */
function blobBytes(value: ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> { const source = value instanceof Uint8Array ? value : new Uint8Array(value); return new Uint8Array(Array.from(source)); }
async function sha256(data: ArrayBuffer) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map(x => x.toString(16).padStart(2, "0")).join("") }
/** 认证 secret 只用于 HMAC，避免将 bearer token 明文写入 D1 或日志。 */
async function hmac(env: Env, value: string) {
  if (!env.AUTH_TOKEN_SECRET) throw new Error("auth_secret_missing");
  const key = await crypto.subtle.importKey("raw", bytes(env.AUTH_TOKEN_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes(value)));
}
function jsonPart(value: unknown) { return b64(bytes(JSON.stringify(value)).buffer) }
function parseJSONPart<T>(value: string): T | null { const raw = safeFromB64(value); if (!raw) return null; try { return JSON.parse(new TextDecoder().decode(raw)) as T } catch { return null } }
async function issueAccessToken(env: Env, hostID: string, epoch: number) {
  const issuedAt = now(); const payload: HostAccess = { iss: "event-voice-booth", aud: "host-api", hostID, epoch, iat: issuedAt, exp: issuedAt + 900 };
  const signed = `${jsonPart({ alg: "HS256", typ: "EVB" })}.${jsonPart(payload)}`;
  return `${signed}.${b64((await hmac(env, signed)).buffer)}`;
}
type BearerAuthentication = { hostID: string | null; failure?: "missing" | "format" | "claims" | "signature" | "host" | "epoch" | "session" | "config" };
/** 只返回脱敏失败类别；绝不记录或回显 bearer、Host ID、Apple subject。 */
async function authenticateBearerDetailed(request: Request, env: Env): Promise<BearerAuthentication> {
  const authorization = request.headers.get("authorization");
  if (!env.AUTH_TOKEN_SECRET) return { hostID: null, failure: "config" };
  if (!authorization) return { hostID: null, failure: "missing" };
  const token = authorization.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/)?.[1];
  if (!token) return { hostID: null, failure: "format" };
  const [headerText, payloadText, signature] = token.split("."); const header = parseJSONPart<{ alg?: string; typ?: string }>(headerText); const payload = parseJSONPart<HostAccess>(payloadText); const supplied = safeFromB64(signature);
  if (!header || header.alg !== "HS256" || header.typ !== "EVB" || !payload || !supplied || payload.iss !== "event-voice-booth" || payload.aud !== "host-api" || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat > now() + 60 || payload.exp <= now() || payload.exp - payload.iat > 900 || !/^[0-9a-f-]{36}$/i.test(payload.hostID)) return { hostID: null, failure: "claims" };
  const expected = await hmac(env, `${headerText}.${payloadText}`); if (!bytesEqual(expected, supplied)) return { hostID: null, failure: "signature" };
  const host = await env.DB.prepare("SELECT auth_epoch,auth_session_expires_at FROM hosts WHERE id=? AND apple_subject IS NOT NULL AND deleting_at IS NULL").bind(payload.hostID).first<{ auth_epoch: number; auth_session_expires_at: number | null }>();
  if (!host) return { hostID: null, failure: "host" };
  if (host.auth_epoch !== payload.epoch) return { hostID: null, failure: "epoch" };
  if ((host.auth_session_expires_at ?? 0) <= now()) return { hostID: null, failure: "session" };
  return { hostID: payload.hostID };
}
async function authenticateBearer(request: Request, env: Env): Promise<string | null> {
  return (await authenticateBearerDetailed(request, env)).hostID;
}
/**
 * Demo 额度只使用 Apple 稳定 subject 的 HMAC 摘要。摘要无法还原 subject，且与认证
 * token、姓名、邮箱隔离；因此删除 Host 账号后仍能保留最低限度的反滥用记账事实。
 */
async function demoSubjectHash(env: Env, subject: string) {
  if (!env.DEMO_QUOTA_SECRET) throw new Error("demo_quota_secret_missing");
  const key = await crypto.subtle.importKey("raw", bytes(env.DEMO_QUOTA_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64(await crypto.subtle.sign("HMAC", key, bytes(`demo-quota:${subject}`)));
}
/**
 * Apple JWKS 按 kid 定位，以 Sign in with Apple 规定的 RS256/RSA 校验签名，并逐项
 * 校验 issuer、audience、过期时间和单次 nonce。
 * Apple identity token 的签发到过期跨度不属于本服务可自行设定的协议；真正的重放
 * 边界是本 Worker 签发且 D1 只消费一次的五分钟 nonce。因此仅要求令牌刚签发，
 * 不能错误假设 Apple 的 exp - iat 必须短于 Host access token 的 15 分钟。
 */
async function verifyAppleIdentityToken(env: Env, token: string, nonce?: string): Promise<AppleIdentity> {
  const parts = token.split("."); if (parts.length !== 3) throw new Error("invalid_identity_token");
  const header = parseJSONPart<{ alg?: string; kid?: string }>(parts[0]); const payload = parseJSONPart<AppleIdentity>(parts[1]); const signature = safeFromB64(parts[2]);
  const issuedAt = payload?.iat;
  if (!header || header.alg !== "RS256" || !header.kid || !payload || !signature || payload.iss !== "https://appleid.apple.com" || typeof payload.sub !== "string" || payload.sub.length > 255 || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(payload.exp)) throw new Error("invalid_identity_claims");
  const validIssuedAt = issuedAt as number;
  if (validIssuedAt > now() + 60 || now() - validIssuedAt > 300 || payload.exp <= now()) throw new Error("invalid_identity_claims");
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud]; if (!audience.includes(env.APP_STORE_BUNDLE_ID)) throw new Error("invalid_identity_audience");
  if (nonce) { const expectedNonce = await sha256(bytes(nonce).buffer); if (payload.nonce !== expectedNonce) throw new Error("invalid_identity_nonce"); }
  type AppleJWK = JsonWebKey & { kid?: string };
  const jwks = await fetch("https://appleid.apple.com/auth/keys", { cf: { cacheTtl: 3600, cacheEverything: true } }).then(async response => response.ok ? response.json() as Promise<{ keys?: AppleJWK[] }> : Promise.reject(new Error("apple_jwks_unavailable")));
  const jwk = jwks.keys?.find(key => key.kid === header.kid && key.kty === "RSA"); if (!jwk) throw new Error("apple_jwk_missing");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, blobBytes(signature), bytes(`${parts[0]}.${parts[1]}`))) throw new Error("invalid_identity_signature");
  return payload;
}
async function issueHostTokens(env: Env, hostID: string, epoch: number) {
  const refreshToken = b64(crypto.getRandomValues(new Uint8Array(48)).buffer); const refreshHash = await sha256(bytes(refreshToken).buffer);
  const session = await env.DB.prepare("SELECT auth_session_expires_at FROM hosts WHERE id=?").bind(hostID).first<{ auth_session_expires_at: number | null }>();
  const authExpiresAt = session?.auth_session_expires_at ?? now();
  await env.DB.prepare("INSERT INTO host_refresh_tokens(id,host_id,token_hash,auth_epoch,expires_at,created_at) VALUES(?,?,?,?,?,?)").bind(id(), hostID, refreshHash, epoch, Math.min(now() + 2_592_000, authExpiresAt), now()).run();
  return { accessToken: await issueAccessToken(env, hostID, epoch), refreshToken, expiresIn: 900 };
}
async function requestJSON<T>(request: Request): Promise<T> { const type = request.headers.get("content-type") || ""; if (!type.startsWith("application/json")) throw new Error("invalid_content_type"); return request.json<T>() }
/** 浏览器只允许正式 Pages 源；原生 Host 不依赖 CORS，而是使用请求签名。 */
function isGuestOrigin(request: Request, env: Env) { return request.headers.get("origin") === env.GUEST_ORIGIN }
function withGuestCORS(response: Response, request: Request, env: Env): Response {
  if (!isGuestOrigin(request, env)) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", env.GUEST_ORIGIN);
  headers.set("access-control-allow-methods", "GET, POST, PUT, OPTIONS");
  headers.set("access-control-allow-headers", "authorization, content-type");
  headers.set("access-control-max-age", "600");
  headers.append("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
async function sessionBySlug(env: Env, slug: string) { return env.DB.prepare("SELECT * FROM sessions WHERE public_slug=?").bind(slug).first<Session>() }
/**
 * Guest 写入以创建时已完成订阅验签的短期 Session 为授权租约。订阅只在创建 Session
 * 时校验；已签发二维码在自身最多 24 小时期限内保持稳定，避免 Sandbox 加速续期或
 * Apple 服务短暂延迟在活动中途切断 Guest。Host 仍可随时 revoke，登录/订阅过期后
 * 不能创建下一张二维码；导入、ACK 与 revoke 继续按 Host 对象授权执行。
 */
async function liveSession(env: Env, slug: string) {
  const s = await env.DB.prepare("SELECT * FROM sessions WHERE public_slug=?").bind(slug).first<Session>();
  return s && s.state === "live" && s.expires_at > now() ? s : null;
}
function ended() { return json({ code: "ended_or_invalid", message: "This guest link is no longer available." }, 410) }
function unauthorizedAt(stage: string, failure?: BearerAuthentication["failure"]) {
  console.warn("web_guest_bearer_rejected", { stage, reason: failure ?? "body" });
  return json({ code: `unauthorized_${stage}_${failure ?? "body"}` }, 401);
}
/**
 * QR 本身是高熵私有能力；对已经拿到 QR 的宾客明确说明到期，避免把“不能再提交”
 * 误解为浏览器或麦克风故障。未知/撤销链接仍使用通用文案，避免暴露活动状态。
 */
async function guestLinkEnded(env: Env, slug: string) {
  const session = await sessionBySlug(env, slug);
  if (session && session.expires_at <= now()) return json({ code: "session_expired", message: "This guest link has expired. The host is no longer accepting new messages." }, 410);
  return ended();
}
function submissionExpired() { return json({ code: "submission_expired", message: "This message was not saved by the host before its 24-hour secure holding period ended." }, 410) }
/**
 * 未 ACK 的媒体只允许作为短期导入缓冲存在。先把 ready 原子标记为 discarded，
 * 再删除私有对象：Host 与清理任务竞争时，Host 只能在仍为 ready 时读取；一旦
 * 标记完成便不会再把已过保留期的内容当作可导入内容返回。
 */
async function purgeExpiredUnacknowledgedMedia(env: Env) {
  const expired = await env.DB.prepare("SELECT id,audio_key,photo_manifest FROM submissions WHERE state='ready' AND expires_at<=? ORDER BY expires_at LIMIT 100").bind(now()).all<Pick<Submission, "id" | "audio_key" | "photo_manifest">>();
  let purged = 0;
  for (const submission of expired.results) {
    const changed = await env.DB.prepare("UPDATE submissions SET state='discarded' WHERE id=? AND state='ready' AND expires_at<=?").bind(submission.id, now()).run();
    if (!changed.meta.changes) continue;
    await env.MEDIA.delete([submission.audio_key, ...parsePhotos(submission.photo_manifest).map(photo => photo.key)]);
    purged += 1;
  }
  // 未完成 finalize 的媒体没有 submission 行；同样从实际上传起最多保留 24 小时。
  const abandonedUploads = await env.DB.prepare("SELECT id,session_id FROM capabilities WHERE consumed_at IS NOT NULL AND consumed_at<=? AND upload_state IN ('uploaded','finalizing') ORDER BY consumed_at LIMIT 100").bind(now() - 86_400).all<Pick<Capability, "id" | "session_id">>();
  for (const capability of abandonedUploads.results) {
    await env.MEDIA.delete(`quarantine/${capability.session_id}/${capability.id}`);
  }
  // Session 是否可供 Guest 写入始终由 state 与 expires_at 联合判定。不要在清理任务中
  // 改成 expired：Host 仍须能在停止活动时发起已签名 revoke，形成可验证的关闭记录。
  return { submissions: purged, abandonedUploads: abandonedUploads.results.length };
}
function tooManyRequests(retryAfter: number) { return json({ code: "rate_limited", message: "Please wait before trying again." }, 429, { "retry-after": String(Math.max(1, retryAfter)) }) }
function capacityExhausted() { return json({ code: "event_capacity_reached", message: "The host is not accepting more web messages for this event." }, 429, { "retry-after": "3600" }) }

/** 原始 IP 仅用于这一请求；持久化前必须与部署 secret 做 HMAC，避免 D1 保存个人网络地址。 */
async function visitorIPHash(request: Request, env: Env): Promise<string | null> {
  const address = request.headers.get("CF-Connecting-IP");
  if (!address || !env.IP_HASH_SALT) return null;
  const key = await crypto.subtle.importKey("raw", bytes(env.IP_HASH_SALT), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64(await crypto.subtle.sign("HMAC", key, bytes(address)));
}

/** D1 条件 UPSERT 在达到阈值时不增加计数，避免并发请求越过配额。 */
async function consumeRateLimit(env: Env, limit: RateLimit): Promise<number | null> {
  const started = now() - (now() % limit.windowSeconds);
  const result = await env.DB.prepare(
    "INSERT INTO rate_windows(scope,bucket_start,request_count) VALUES(?,?,1) ON CONFLICT(scope,bucket_start) DO UPDATE SET request_count=request_count+1 WHERE request_count<?"
  ).bind(limit.scope, started, limit.maximum).run();
  return result.meta.changes ? null : limit.windowSeconds - (now() - started);
}

async function consumeAllRateLimits(env: Env, limits: RateLimit[]): Promise<number | null> {
  for (const limit of limits) { const retryAfter = await consumeRateLimit(env, limit); if (retryAfter !== null) return retryAfter; }
  return null;
}

/**
 * 无账号 Host 以服务端已验证的身份与操作类别为键限速，避免伪造 Header/IP 造成误伤。
 * Challenge 与目标敏感请求必须使用独立桶；否则每个业务操作会被同一 scope 计数两次，
 * challenge 还会提前耗尽敏感操作额度，使合法 Sync 在一小时内错误返回 429。
 */
async function consumeHostRateLimit(env: Env, category: "challenge" | "sensitive", hostID: string, limit: Omit<RateLimit, "scope">): Promise<number | null> {
  return consumeRateLimit(env, { ...limit, scope: `host:${category}:${hostID}` });
}

/** 用短租约硬封顶上传并发；即使浏览器断开，租约到期后仍会恢复可用名额。 */
async function acquireUploadLease(env: Env, sessionID: string, capabilityID: string, ipHash: string): Promise<UploadLease | null> {
  const expiresAt = now() + 120; const leaseID = id();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM upload_leases WHERE expires_at<=?").bind(now()),
    env.DB.prepare("INSERT INTO upload_leases(id,session_id,capability_id,ip_hash,expires_at) SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM upload_leases WHERE session_id=? AND expires_at>?)<4 AND (SELECT COUNT(*) FROM upload_leases WHERE ip_hash=? AND expires_at>?)<2").bind(leaseID, sessionID, capabilityID, ipHash, expiresAt, sessionID, now(), ipHash, now())
  ]);
  const lease = await env.DB.prepare("SELECT id FROM upload_leases WHERE id=?").bind(leaseID).first<{ id: string }>();
  return lease ? { id: lease.id, sessionID } : null;
}
async function releaseUploadLease(env: Env, lease: UploadLease | null) { if (lease) await env.DB.prepare("DELETE FROM upload_leases WHERE id=?").bind(lease.id).run(); }

/** Host 请求以安装私钥签名：method\npath\ntimestamp\nnonce\nsha256(body)。nonce 一次性保存，避免重放。 */
async function authenticateHost(request: Request, env: Env, body: ArrayBuffer): Promise<{ host: AttestedHost; canonical: string } | null> {
  const hostID = request.headers.get("x-evb-host"); const timestamp = Number(request.headers.get("x-evb-timestamp")); const nonce = request.headers.get("x-evb-nonce"); const signature = request.headers.get("x-evb-signature");
  if (!hostID || !nonce || !signature || !Number.isSafeInteger(timestamp) || Math.abs(now() - timestamp) > 300) return null;
  const host = await env.DB.prepare("SELECT id,public_key,app_attest_key_id,app_attest_public_key_pem,app_attest_sign_count FROM hosts WHERE id=?").bind(hostID).first<AttestedHost>();
  if (!host) return null;
  const registeredHost = host;
  async function reject(stage: string) { console.warn("web_guest_host_rejected", { stage }); await env.DB.prepare("UPDATE hosts SET last_assertion_failure=? WHERE id=?").bind(stage, registeredHost.id).run(); return null; }
  const replay = await env.DB.prepare("SELECT 1 FROM host_nonces WHERE host_id=? AND nonce=? AND expires_at>? ").bind(hostID, nonce, now()).first(); if (replay) return reject("host_nonce_replay");
  const digest = await sha256(body); const canonical = `${request.method}\n${new URL(request.url).pathname}\n${timestamp}\n${nonce}\n${digest}`;
  const rawSignature = safeFromB64(signature); if (!rawSignature) return reject("host_signature_format");
  let key: CryptoKey;
  try { key = await crypto.subtle.importKey("raw", blobBytes(host.public_key), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]); } catch { return reject("host_public_key"); }
  const signatureBytes = new Uint8Array(rawSignature.byteLength); signatureBytes.set(rawSignature);
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signatureBytes.buffer, bytes(canonical))) return reject("host_signature_verify");
  // 签名验真后再原子占用 nonce；并发重放只能有一个请求成功。
  const nonceInsert = await env.DB.prepare("INSERT OR IGNORE INTO host_nonces(host_id,nonce,expires_at) VALUES(?,?,?)").bind(hostID, nonce, now() + 600).run();
  if (!nonceInsert.meta.changes) return reject("host_nonce_insert");
  await env.DB.prepare("DELETE FROM host_nonces WHERE expires_at<=?").bind(now()).run();
  await env.DB.prepare("UPDATE hosts SET last_assertion_failure=NULL WHERE id=?").bind(host.id).run();
  return { host, canonical };
}
/**
 * 每个已注册 Host 的敏感操作都需一次 App Attest assertion。challenge 同时绑定待执行的
 * Host 请求 canonical digest；即使 Host 请求签名泄露，也不能被离线重放或换到另一条请求。
 */
async function authenticateAttestedHost(request: Request, env: Env, body: ArrayBuffer): Promise<{ data: ArrayBuffer; hostID: string } | null> {
  const authenticated = await authenticateHost(request, env, body); if (!authenticated) { console.warn("web_guest_host_rejected", { stage: "request_signature" }); return null; }
  const { host, canonical } = authenticated;
  const keyID = request.headers.get("x-evb-app-attest-key-id"); const assertion = request.headers.get("x-evb-app-attest-assertion"); const challengeText = request.headers.get("x-evb-app-attest-challenge");
  const challenge = challengeText && safeFromB64(challengeText);
  async function reject(stage: string) { console.warn("web_guest_host_rejected", { stage }); await env.DB.prepare("UPDATE hosts SET last_assertion_failure=? WHERE id=?").bind(stage, host.id).run(); return null; }
  if (!host.app_attest_key_id || !host.app_attest_public_key_pem || !keyID || keyID !== host.app_attest_key_id || !assertion || !challenge || challenge.byteLength !== 32) return reject("assertion_headers");
  const challengeRow = await env.DB.prepare("SELECT id,bound_host_id,bound_public_key FROM host_challenges WHERE purpose='assert' AND challenge=? AND expires_at>? AND consumed_at IS NULL").bind(challenge, now()).first<{ id: string; bound_host_id: string; bound_public_key: ArrayBuffer }>();
  if (!challengeRow || challengeRow.bound_host_id !== host.id || !challengeRow.bound_public_key || !bytesEqual(challengeRow.bound_public_key, host.public_key)) return reject("assertion_challenge");
  const expectedDigest = await sha256(bytes(canonical).buffer);
  const storedDigest = await env.DB.prepare("SELECT request_digest FROM host_challenges WHERE id=?").bind(challengeRow.id).first<{ request_digest: string | null }>();
  if (!storedDigest?.request_digest || storedDigest.request_digest !== expectedDigest) return reject("assertion_digest");
  try {
    const clientData = concatBytes(bytes("EVB-AppAttest-v1"), challenge, new Uint8Array(host.public_key));
    const verified = await verifyAssertion({ appId: env.APP_ATTEST_APP_ID }, assertion, clientData, host.app_attest_public_key_pem, host.app_attest_sign_count);
    // challenge 消费与计数器 CAS 必须同时成功；并发 assertion 只能有一个通过。
    const results = await env.DB.batch([
      env.DB.prepare("UPDATE host_challenges SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND expires_at>?").bind(now(), challengeRow.id, now()),
      env.DB.prepare("UPDATE hosts SET app_attest_sign_count=?,last_attested_at=? WHERE id=? AND app_attest_sign_count=?").bind(verified.signCount, now(), host.id, host.app_attest_sign_count)
    ]);
    if (!results[0].meta.changes || !results[1].meta.changes) return reject("assertion_replay");
    await env.DB.prepare("UPDATE hosts SET last_assertion_failure=NULL WHERE id=?").bind(host.id).run();
    return { data: body, hostID: host.id };
  } catch (error) {
    const reason = error instanceof Error ? error.name : "unknown";
    console.warn("web_guest_host_rejected", { stage: "assertion_verify", reason });
    return reject("assertion_verify");
  }
}
function concatBytes(...parts: Uint8Array[]) { const total = parts.reduce((sum, value) => sum + value.byteLength, 0); const joined = new Uint8Array(total); let offset = 0; for (const part of parts) { joined.set(part, offset); offset += part.byteLength; } return joined }
function bytesEqual(left: ArrayBuffer | Uint8Array, right: ArrayBuffer | Uint8Array) { const a = blobBytes(left); const b = blobBytes(right); if (a.byteLength !== b.byteLength) return false; let different = 0; for (let index = 0; index < a.byteLength; index += 1) different |= a[index] ^ b[index]; return different === 0 }
/**
 * Session 与媒体管理是登录后的 Host 权限边界，只接受仍在服务端会话期限内的 bearer。
 * 旧 P-256/App Attest 凭据仅可在 `/v1/auth/apple` 认领历史 Host，不能继续管理媒体。
 */
async function hostBody(request: Request, env: Env) {
  const data = await request.arrayBuffer(); const bearer = await authenticateBearerDetailed(request, env);
  if (bearer.hostID) return { data, hostID: bearer.hostID, authenticatedBy: "bearer" as const, authFailure: undefined };
  return { data, hostID: null, authenticatedBy: null, authFailure: bearer.failure };
}
function expectString(value: unknown, max = 160) { return typeof value === "string" && value.length > 0 && value.length <= max ? value : null }
function mediaMagic(kind: "audio" | "photo", data: Uint8Array) {
  if (kind === "photo") return data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  // Safari produces MP4/AAC (ftyp); other codecs are deliberately rejected until a native importer is added.
  return data.length > 12 && new TextDecoder().decode(data.slice(4, 8)) === "ftyp";
}

/** 外部 API 绝不返回 R2 对象键；Host 只看到用于完整性校验的元数据。 */
function publicSubmission(submission: Pick<Submission, "id" | "audio_bytes" | "audio_sha256" | "photo_manifest" | "created_at">) {
  const photos = parsePhotos(submission.photo_manifest);
  return { id: submission.id, audioBytes: submission.audio_bytes, audioSHA256: submission.audio_sha256, photos: photos.map(photo => ({ bytes: photo.bytes, sha256: photo.sha256 })), createdAt: submission.created_at };
}
function parsePhotos(value: string): StoredPhoto[] { try { const decoded: unknown = JSON.parse(value); return Array.isArray(decoded) && decoded.every(item => typeof item === "object" && item !== null && typeof item.key === "string" && typeof item.bytes === "number" && typeof item.sha256 === "string") ? decoded as StoredPhoto[] : []; } catch { return [] } }
function guestReceipt() { return b64(crypto.getRandomValues(new Uint8Array(32)).buffer) }

/** Host 注册只接受服务器创建的一次性 challenge，避免 attestation/交易 JWS 被重放。 */
async function issueHostChallenge(env: Env, publicKey: Uint8Array): Promise<{ challenge: string; expiresAt: number }> {
  const challenge = crypto.getRandomValues(new Uint8Array(32)); const expiresAt = now() + 300;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM host_challenges WHERE expires_at<=?").bind(now()),
    env.DB.prepare("INSERT INTO host_challenges(id,purpose,challenge,expires_at,bound_public_key) VALUES(?,?,?,?,?)").bind(id(), "register", challenge, expiresAt, publicKey)
  ]);
  return { challenge: b64(challenge.buffer), expiresAt };
}

/**
 * 交易 JWS 必须由 Apple 根证书验证，并限制精确 Bundle、商品和未撤销状态。
 * 生产与 Sandbox 交易都必须使用各自的 Apple 环境 verifier 完整验签；绝不接受
 * 未签名收据或本机购买布尔值。
 */
async function verifyHostPurchase(env: Env, signedTransaction: string): Promise<{ transactionID: string; originalTransactionID: string; expiresAt: number }> {
  const root = fromB64("MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtfTjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySrMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM6BgD56KyKA==");
  let transaction: Awaited<ReturnType<SignedDataVerifier["verifyAndDecodeTransaction"]>>;
  try {
    transaction = await new SignedDataVerifier([root], true, Environment.PRODUCTION, env.APP_STORE_BUNDLE_ID, Number(env.APP_APPLE_ID)).verifyAndDecodeTransaction(signedTransaction);
  } catch {
    transaction = await new SignedDataVerifier([root], true, Environment.SANDBOX, env.APP_STORE_BUNDLE_ID, Number(env.APP_APPLE_ID)).verifyAndDecodeTransaction(signedTransaction);
  }
  const monthly = transaction.productId === "com.eventvoicebooth.host.monthly";
  const expiresAt = Math.floor((transaction.expiresDate || 0) / 1000);
  if (transaction.bundleId !== env.APP_STORE_BUNDLE_ID || !monthly || (transaction.environment !== Environment.PRODUCTION && transaction.environment !== Environment.SANDBOX) || transaction.revocationDate || !transaction.transactionId || !transaction.originalTransactionId || expiresAt <= now()) throw new Error("invalid_purchase");
  return { transactionID: transaction.transactionId, originalTransactionID: transaction.originalTransactionId, expiresAt };
}

export default { async fetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url); const path = url.pathname; const parts = path.split("/").filter(Boolean);
  // 仅正式 Guest Pages 可取得 CORS 预检许可；其它站点不能借浏览器发起写入。
  if (request.method === "OPTIONS") return isGuestOrigin(request, env) ? withGuestCORS(empty(204), request, env) : json({ code: "invalid_origin" }, 403);
  if (path === "/health") return json({ ok: true });
  /**
   * 先由 Worker 签发短期随机 nonce，再让系统 Apple 授权把其 SHA-256 带入 identity
   * token。D1 条件消费确保同一 challenge 即使被并发提交也只会成功一次。
   */
  if (path === "/v1/auth/apple/challenge" && request.method === "POST") {
    if (env.APPLE_HOST_AUTH_ENABLED !== "true") return json({ code: "host_auth_migration_unavailable" }, 503);
    const ipHash = await visitorIPHash(request, env); if (!ipHash) return json({ code: "service_unavailable" }, 503);
    const retryAfter = await consumeRateLimit(env, { ...limits.appleChallengeIP, scope: `auth:apple-challenge:ip:${ipHash}` });
    if (retryAfter !== null) return tooManyRequests(retryAfter);
    const nonce = b64(crypto.getRandomValues(new Uint8Array(32)).buffer);
    const nonceHash = await sha256(bytes(nonce).buffer);
    await env.DB.prepare("DELETE FROM apple_auth_challenges WHERE expires_at<=?").bind(now()).run();
    await env.DB.prepare("INSERT INTO apple_auth_challenges(nonce_hash,expires_at) VALUES(?,?)").bind(nonceHash, now() + 300).run();
    return json({ nonce, expiresAt: now() + 300 }, 201);
  }
  /**
   * Sign in with Apple 是 Host 的主身份入口。identity token 只用于本次登录验证；
   * 服务端仅保存 Apple `sub`，不保存姓名、邮箱或 identity token。旧 Host 需用原
   * P-256 私钥签名同一请求才能认领，故不能凭本机 Event 数据或 UUID 越权迁移。
   */
  if ((path === "/v1/auth/apple" || path === "/v1/auth/refresh" || path === "/v1/auth/logout") && env.APPLE_HOST_AUTH_ENABLED !== "true") {
    return json({ code: "host_auth_migration_unavailable" }, 503);
  }
  if (path === "/v1/auth/apple" && request.method === "POST") {
    const ipHash = await visitorIPHash(request, env); if (!ipHash) return json({ code: "service_unavailable" }, 503);
    const authRetryAfter = await consumeRateLimit(env, { ...limits.appleLoginIP, scope: `auth:apple-login:ip:${ipHash}` });
    if (authRetryAfter !== null) return tooManyRequests(authRetryAfter);
    const data = await request.arrayBuffer();
    const payload = (() => { try { return JSON.parse(new TextDecoder().decode(data)) as { identityToken?: string; nonce?: string; signedTransaction?: string; legacyHostID?: string; publicKey?: string } } catch { return null } })();
    const identityToken = payload && expectString(payload.identityToken, 12_000); const signedTransaction = payload && (payload.signedTransaction === undefined ? undefined : expectString(payload.signedTransaction, 32_768)); const nonce = payload && expectString(payload.nonce, 128);
    if (!payload || !identityToken || !nonce || (payload.signedTransaction !== undefined && !signedTransaction)) return json({ code: "invalid_request" }, 400);
    const nonceHash = await sha256(bytes(nonce).buffer);
    const consumedNonce = await env.DB.prepare("UPDATE apple_auth_challenges SET consumed_at=? WHERE nonce_hash=? AND consumed_at IS NULL AND expires_at>?").bind(now(), nonceHash, now()).run();
    if (!consumedNonce.meta.changes) return json({ code: "invalid_apple_challenge" }, 401);
    let identity: AppleIdentity; let purchase: { transactionID: string; originalTransactionID: string; expiresAt: number } | undefined;
    try {
      identity = await verifyAppleIdentityToken(env, identityToken, nonce);
    } catch (error) {
      // 仅记录验证阶段和错误类别；不得记录 identity token、Apple sub、nonce 或签名。
      console.warn("web_guest_apple_login_rejected", { stage: "identity", reason: error instanceof Error ? error.message : "verification" });
      return json({ code: appleIdentityFailureCode(error) }, 401);
    }
    if (signedTransaction) try {
      purchase = await verifyHostPurchase(env, signedTransaction);
    } catch (error) {
      // StoreKit JWS 可能因 Sandbox 自动续期、恢复尚未完成或验签失败而不可用。
      // 对外不回显交易、环境或证书细节，客户端据此给出可恢复的购买刷新指引。
      console.warn("web_guest_apple_login_rejected", { stage: "purchase", reason: error instanceof Error ? error.message : "verification" });
      return json({ code: "host_purchase_verification_failed" }, 401);
    }
    const existing = await env.DB.prepare("SELECT id,auth_epoch FROM hosts WHERE apple_subject=?").bind(identity.sub).first<{ id: string; auth_epoch: number }>();
    const purchaseOwner = purchase ? await env.DB.prepare("SELECT id,apple_subject FROM hosts WHERE original_transaction_id=?").bind(purchase.originalTransactionID).first<{ id: string; apple_subject: string | null }>() : null;
    if (purchaseOwner && purchaseOwner.apple_subject && purchaseOwner.apple_subject !== identity.sub) return json({ code: "purchase_already_bound" }, 409);
    let hostID = existing?.id; let epoch = existing?.auth_epoch ?? 0;
    const requestedLegacy = payload.legacyHostID ? await env.DB.prepare("SELECT id,apple_subject FROM hosts WHERE id=?").bind(payload.legacyHostID).first<{ id: string; apple_subject: string | null }>() : null;
    const requestedUnboundLegacy = requestedLegacy && !requestedLegacy.apple_subject ? requestedLegacy : null;
    if (payload.legacyHostID && requestedUnboundLegacy) {
      // 历史 Host 认领必须由旧安装保留的 P-256 私钥签署完全相同的 Apple 登录 body。
      // 不允许仅凭 StoreKit 原交易或本地 Event/QR 推断归属，避免失窃购买记录被用于
      // 接管另一台设备仍保留的历史 Host。
      const legacy = await authenticateHost(request, env, data);
      const claimHostID = legacy?.host.id === payload.legacyHostID ? legacy.host.id : null;
      if (!claimHostID) return json({ code: "legacy_claim_failed" }, 401);
      const legacyPurchase = await env.DB.prepare("SELECT original_transaction_id FROM hosts WHERE id=?").bind(claimHostID).first<{ original_transaction_id: string | null }>();
      if (purchase && (!legacyPurchase?.original_transaction_id || legacyPurchase.original_transaction_id !== purchase.originalTransactionID)) return json({ code: "legacy_purchase_mismatch" }, 409);
      if (existing && existing.id !== claimHostID) return json({ code: "apple_identity_already_bound" }, 409);
      if (purchaseOwner && purchaseOwner.id !== claimHostID) return json({ code: "purchase_already_bound" }, 409);
      const authSessionExpiresAt = now() + 604_800;
      const claimed = purchase
        ? await env.DB.prepare("UPDATE hosts SET apple_subject=?,transaction_id=?,original_transaction_id=?,subscription_expires_at=?,auth_session_expires_at=?,auth_epoch=auth_epoch+1 WHERE id=? AND apple_subject IS NULL AND original_transaction_id=?").bind(identity.sub, purchase.transactionID, purchase.originalTransactionID, purchase.expiresAt, authSessionExpiresAt, claimHostID, purchase.originalTransactionID).run()
        : await env.DB.prepare("UPDATE hosts SET apple_subject=?,auth_session_expires_at=?,auth_epoch=auth_epoch+1 WHERE id=? AND apple_subject IS NULL").bind(identity.sub, authSessionExpiresAt, claimHostID).run();
      if (!claimed.meta.changes) return json({ code: "legacy_claim_conflict" }, 409);
      hostID = claimHostID; epoch = (await env.DB.prepare("SELECT auth_epoch FROM hosts WHERE id=?").bind(hostID).first<{ auth_epoch: number }>())!.auth_epoch;
    } else if (existing) {
      // 已绑定 Apple 的 Host 可能仍由同一安装携带 legacyHostID。它属于正常再次登录，
      // 不能重新进入只接受 `apple_subject IS NULL` 的首次认领分支。
      if (requestedLegacy && requestedLegacy.id !== existing.id) return json({ code: "apple_identity_already_bound" }, 409);
      if (purchase) await env.DB.prepare("UPDATE hosts SET transaction_id=?,original_transaction_id=?,subscription_expires_at=? WHERE id=?").bind(purchase.transactionID, purchase.originalTransactionID, purchase.expiresAt, existing.id).run();
      await env.DB.prepare("UPDATE hosts SET auth_session_expires_at=?,auth_epoch=auth_epoch+1 WHERE id=?").bind(now() + 604_800, existing.id).run();
    } else {
      // 新账号只在身份令牌与当前有效 Host Monthly 同时成立时创建 Host；P-256 是旧数据
      // 认领与兼容期所需的恢复凭据，不再用于每条同步/下载/ACK 的主认证。
      const raw = payload.publicKey && safeFromB64(payload.publicKey);
      if (!raw || raw.byteLength !== 65 || raw[0] !== 4) return json({ code: "public_key_required" }, 400);
      hostID = id();
      try {
        await env.DB.prepare("INSERT INTO hosts(id,public_key,transaction_id,original_transaction_id,subscription_expires_at,apple_subject,auth_session_expires_at,created_at,registered_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(hostID, raw, purchase?.transactionID ?? null, purchase?.originalTransactionID ?? null, purchase?.expiresAt ?? null, identity.sub, now() + 604_800, now(), now()).run();
      } catch { return json({ code: "host_create_conflict" }, 409); }
    }
    const host = await env.DB.prepare("SELECT auth_epoch FROM hosts WHERE id=? AND apple_subject=?").bind(hostID, identity.sub).first<{ auth_epoch: number }>();
    if (!host) return json({ code: "host_create_conflict" }, 409);
    return json({ hostID, ...await issueHostTokens(env, hostID!, host.auth_epoch) }, 201);
  }
  /**
   * Refresh token 单次轮换。任意旧 token 重放都视为令牌泄露：提升 auth epoch 并撤销
   * 该 Host 的全部 refresh token，使当前 access token 也立即失效，随后要求重新 Apple 登录。
   */
  if (path === "/v1/auth/refresh" && request.method === "POST") {
    const ipHash = await visitorIPHash(request, env); if (!ipHash) return json({ code: "service_unavailable" }, 503);
    const ipRetryAfter = await consumeRateLimit(env, { ...limits.refreshIP, scope: `auth:refresh:ip:${ipHash}` });
    if (ipRetryAfter !== null) return tooManyRequests(ipRetryAfter);
    const payload = await requestJSON<{ refreshToken?: string }>(request).catch(() => null); const refreshToken = payload && expectString(payload.refreshToken, 128);
    if (!refreshToken) return json({ code: "invalid_request" }, 400);
    const tokenHash = await sha256(bytes(refreshToken).buffer);
    const row = await env.DB.prepare("SELECT r.id,r.host_id,h.auth_epoch FROM host_refresh_tokens r JOIN hosts h ON h.id=r.host_id WHERE r.token_hash=? AND r.auth_epoch=h.auth_epoch AND r.revoked_at IS NULL AND r.expires_at>? AND h.auth_session_expires_at>? AND h.apple_subject IS NOT NULL").bind(tokenHash, now(), now()).first<{ id: string; host_id: string; auth_epoch: number }>();
    if (!row) {
      // token 摘要只用于服务端限流 scope，不写日志、不回显，也不能反推出原 token。
      const failureRetryAfter = await consumeRateLimit(env, { ...limits.refreshFailureToken, scope: `auth:refresh-failure:token:${tokenHash}` });
      if (failureRetryAfter !== null) return tooManyRequests(failureRetryAfter);
      const known = await env.DB.prepare("SELECT id,host_id FROM host_refresh_tokens WHERE token_hash=?").bind(tokenHash).first<{ id: string; host_id: string }>();
      if (known) {
        // 条件更新是一次性重放检测的线性化点。同一旧 token 后续重放不再反复
        // 提升 epoch，但仍统一返回 401，避免向外泄露 token 是否曾经有效。
        const detected = await env.DB.prepare("UPDATE host_refresh_tokens SET replay_detected_at=? WHERE id=? AND replay_detected_at IS NULL").bind(now(), known.id).run();
        if (detected.meta.changes) await env.DB.batch([
          env.DB.prepare("UPDATE hosts SET auth_epoch=auth_epoch+1 WHERE id=?").bind(known.host_id),
          env.DB.prepare("UPDATE host_refresh_tokens SET revoked_at=? WHERE host_id=? AND revoked_at IS NULL").bind(now(), known.host_id)
        ]);
      }
      return json({ code: "unauthorized" }, 401);
    }
    const consumed = await env.DB.prepare("UPDATE host_refresh_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL").bind(now(), row.id).run();
    if (!consumed.meta.changes) {
      // 两个并发 refresh 可能都在读取后抵达这里。失去 CAS 的调用同样说明已使用
      // refresh token 被重放，必须立即使同一 Host 的 access/refresh token 家族失效。
      const detected = await env.DB.prepare("UPDATE host_refresh_tokens SET replay_detected_at=? WHERE id=? AND replay_detected_at IS NULL").bind(now(), row.id).run();
      if (detected.meta.changes) await env.DB.batch([
        env.DB.prepare("UPDATE hosts SET auth_epoch=auth_epoch+1 WHERE id=?").bind(row.host_id),
        env.DB.prepare("UPDATE host_refresh_tokens SET revoked_at=? WHERE host_id=? AND revoked_at IS NULL").bind(now(), row.host_id)
      ]);
      return json({ code: "unauthorized" }, 401);
    }
    return json(await issueHostTokens(env, row.host_id, row.auth_epoch));
  }
  if (path === "/v1/auth/logout" && request.method === "POST") {
    const hostID = await authenticateBearer(request, env); if (!hostID) return json({ code: "unauthorized" }, 401);
    // 仅撤销该 Host 的刷新令牌；短 access token 最多还剩 15 分钟，避免客户端网络
    // 中断时误把 logout 当作不可逆删除 Event 的操作。
    await env.DB.prepare("UPDATE host_refresh_tokens SET revoked_at=? WHERE host_id=? AND revoked_at IS NULL").bind(now(), hostID).run();
    await env.DB.prepare("UPDATE hosts SET auth_epoch=auth_epoch+1 WHERE id=?").bind(hostID).run();
    return empty(204);
  }
  if (path === "/v1/auth/account" && request.method === "DELETE") {
    const authentication = await authenticateBearerDetailed(request, env);
    if (!authentication.hostID) return unauthorizedAt("account", authentication.failure);
    const data = await request.arrayBuffer();
    if (data.byteLength) return unauthorizedAt("account");
    const hostID = authentication.hostID;
    // App 必须先完成 drain → ACK → revoke。服务端再次 fail-closed，避免删除账号后
    // ready 媒体失去唯一可证明的 Host 恢复入口。
    // 条件更新是删除锁的线性化点：live/ready 或仍在 finalize 的上传存在时不加锁；
    // 加锁后认证和 Guest reservation 都拒绝新工作，避免检查后又产生 ready 投稿。
    const locked = await env.DB.prepare(`UPDATE hosts SET deleting_at=? WHERE id=? AND deleting_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM sessions WHERE host_id=? AND state='live')
      AND NOT EXISTS (SELECT 1 FROM submissions sub JOIN sessions s ON s.id=sub.session_id WHERE s.host_id=? AND sub.state='ready')
      AND NOT EXISTS (SELECT 1 FROM capabilities c JOIN sessions s ON s.id=c.session_id WHERE s.host_id=? AND c.upload_state IN ('uploading','uploaded','finalizing'))`)
      .bind(now(), hostID, hostID, hostID, hostID).run();
    if (!locked.meta.changes) return json({ code: "account_cleanup_required" }, 409);
    const sessions = await env.DB.prepare("SELECT id FROM sessions WHERE host_id=?").bind(hostID).all<{ id: string }>();
    if (sessions.results.length) {
      const ids = sessions.results.map(session => session.id);
      const placeholders = ids.map(() => "?").join(",");
      const submissions = await env.DB.prepare(`SELECT audio_key,photo_manifest FROM submissions WHERE session_id IN (${placeholders})`).bind(...ids).all<Pick<Submission, "audio_key" | "photo_manifest">>();
      const capabilities = await env.DB.prepare(`SELECT id,session_id FROM capabilities WHERE session_id IN (${placeholders})`).bind(...ids).all<Pick<Capability, "id" | "session_id">>();
      const objectKeys = submissions.results.flatMap(submission => [submission.audio_key, ...parsePhotos(submission.photo_manifest).map(photo => photo.key)]).filter(Boolean);
      objectKeys.push(...capabilities.results.map(capability => `quarantine/${capability.session_id}/${capability.id}`));
      // R2 删除失败时不触碰 D1，允许用户安全重试；删除不存在对象是幂等操作。
      if (objectKeys.length) await env.MEDIA.delete(objectKeys);
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM upload_leases WHERE session_id IN (${placeholders})`).bind(...ids),
        env.DB.prepare(`DELETE FROM capabilities WHERE session_id IN (${placeholders})`).bind(...ids),
        env.DB.prepare(`DELETE FROM submissions WHERE session_id IN (${placeholders})`).bind(...ids),
        env.DB.prepare(`DELETE FROM sessions WHERE id IN (${placeholders}) AND host_id=?`).bind(...ids, hostID)
      ]);
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM host_refresh_tokens WHERE host_id=?").bind(hostID),
      env.DB.prepare("DELETE FROM host_nonces WHERE host_id=?").bind(hostID),
      env.DB.prepare("DELETE FROM host_challenges WHERE bound_host_id=?").bind(hostID),
      env.DB.prepare("DELETE FROM hosts WHERE id=?").bind(hostID)
    ]);
    return empty(204);
  }
  /**
   * 试用配额只对已登录 Host 开放。客户端在录音完成后以录音 UUID 申领一条：同一 UUID
   * 的重试返回同一成功结果；不同 UUID 通过 D1 条件更新最多只可累计三条。
   */
  if (path === "/v1/host/demo-quota" && request.method === "GET") {
    const { data, hostID, authFailure } = await hostBody(request, env);
    if (!hostID || data.byteLength) return unauthorizedAt("demo_quota", authFailure);
    const host = await env.DB.prepare("SELECT apple_subject,subscription_expires_at FROM hosts WHERE id=? AND deleting_at IS NULL").bind(hostID).first<{ apple_subject: string | null; subscription_expires_at: number | null }>();
    if (!host?.apple_subject) return unauthorizedAt("demo_quota");
    if ((host.subscription_expires_at ?? 0) > now()) return json({ used: 0, remaining: 3 });
    if (!env.DEMO_QUOTA_SECRET) return json({ code: "service_unavailable" }, 503);
    const subjectHash = await demoSubjectHash(env, host.apple_subject);
    const quota = await env.DB.prepare("SELECT message_count FROM demo_quotas WHERE subject_hash=?").bind(subjectHash).first<{ message_count: number }>();
    const used = quota?.message_count ?? 0;
    return json({ used, remaining: Math.max(0, 3 - used) });
  }
  if (path === "/v1/host/demo-quota/claims" && request.method === "POST") {
    const { data, hostID, authFailure } = await hostBody(request, env);
    if (!hostID) return unauthorizedAt("demo_quota_claim", authFailure);
    const payload = (() => { try { return JSON.parse(new TextDecoder().decode(data)) as { recordingID?: unknown } } catch { return null } })();
    const recordingID = payload && typeof payload.recordingID === "string" && /^[0-9a-f-]{36}$/i.test(payload.recordingID) ? payload.recordingID : null;
    if (!recordingID) return json({ code: "invalid_request" }, 400);
    const host = await env.DB.prepare("SELECT apple_subject,subscription_expires_at FROM hosts WHERE id=? AND deleting_at IS NULL").bind(hostID).first<{ apple_subject: string | null; subscription_expires_at: number | null }>();
    if (!host?.apple_subject) return unauthorizedAt("demo_quota_claim");
    // 订阅资格由 Worker 自己的 StoreKit 验签刷新，不能相信客户端的本地购买布尔值。
    if ((host.subscription_expires_at ?? 0) > now()) return json({ granted: true, remaining: 3 });
    if (!env.DEMO_QUOTA_SECRET) return json({ code: "service_unavailable" }, 503);
    const subjectHash = await demoSubjectHash(env, host.apple_subject);
    const existing = await env.DB.prepare("SELECT counted_at FROM demo_message_claims WHERE subject_hash=? AND recording_id=?").bind(subjectHash, recordingID).first<{ counted_at: number | null }>();
    if (existing?.counted_at) {
      const quota = await env.DB.prepare("SELECT message_count FROM demo_quotas WHERE subject_hash=?").bind(subjectHash).first<{ message_count: number }>();
      return json({ granted: true, remaining: Math.max(0, 3 - (quota?.message_count ?? 3)) });
    }
    // D1 batch 在单一事务内顺序执行：先确保计数行存在，再仅在未满额时插入本录音
    // claim、计数并标记。失败的条件更新不会产生可被后续重试误认为成功的 claim。
    await env.DB.batch([
      env.DB.prepare("INSERT INTO demo_quotas(subject_hash,message_count,created_at,updated_at) VALUES(?,0,?,?) ON CONFLICT(subject_hash) DO NOTHING").bind(subjectHash, now(), now()),
      env.DB.prepare("INSERT OR IGNORE INTO demo_message_claims(subject_hash,recording_id,claimed_at) SELECT ?,?,? WHERE (SELECT message_count FROM demo_quotas WHERE subject_hash=?)<3").bind(subjectHash, recordingID, now(), subjectHash),
      env.DB.prepare("UPDATE demo_quotas SET message_count=message_count+1,last_recording_id=?,updated_at=? WHERE subject_hash=? AND message_count<3 AND EXISTS (SELECT 1 FROM demo_message_claims WHERE subject_hash=? AND recording_id=? AND counted_at IS NULL)").bind(recordingID, now(), subjectHash, subjectHash, recordingID),
      env.DB.prepare("UPDATE demo_message_claims SET counted_at=? WHERE subject_hash=? AND recording_id=? AND counted_at IS NULL AND EXISTS (SELECT 1 FROM demo_quotas WHERE subject_hash=? AND last_recording_id=?)").bind(now(), subjectHash, recordingID, subjectHash, recordingID)
    ]);
    const claim = await env.DB.prepare("SELECT counted_at FROM demo_message_claims WHERE subject_hash=? AND recording_id=?").bind(subjectHash, recordingID).first<{ counted_at: number | null }>();
    if (!claim?.counted_at) {
      await env.DB.prepare("DELETE FROM demo_message_claims WHERE subject_hash=? AND recording_id=? AND counted_at IS NULL").bind(subjectHash, recordingID).run();
      return json({ code: "demo_quota_exhausted" }, 409);
    }
    const quota = await env.DB.prepare("SELECT message_count FROM demo_quotas WHERE subject_hash=?").bind(subjectHash).first<{ message_count: number }>();
    return json({ granted: true, remaining: Math.max(0, 3 - (quota?.message_count ?? 3)) }, 201);
  }
  if (path === "/v1/hosts/registration-challenge" && request.method === "POST") {
    if (env.HOST_REGISTRATION_ENABLED !== "true") return json({ code: "host_registration_unavailable" }, 503);
    const ipHash = await visitorIPHash(request, env); if (!ipHash) return json({ code: "service_unavailable" }, 503);
    // 合法设备在系统 attestation 或网络恢复时可重试。每 IP 每小时 120 次避免恢复
    // 流程自锁；每次仍必须通过 Apple App Attest 与 StoreKit JWS，不能单靠 IP 注册。
    const retryAfter = await consumeAllRateLimits(env, [{ scope: `host-register:ip:${ipHash}`, maximum: 120, windowSeconds: 3_600 }]); if (retryAfter !== null) return tooManyRequests(retryAfter);
    const payload = await requestJSON<{ publicKey: string }>(request).catch(() => null); const raw = payload && expectString(payload.publicKey, 128) ? safeFromB64(payload.publicKey) : null;
    if (!raw || raw.byteLength !== 65 || raw[0] !== 4) return json({ code: "invalid_request" }, 400);
    return json(await issueHostChallenge(env, raw), 201);
  }
  if (path === "/v1/hosts/register" && request.method === "POST") {
    // P0: 注册任何公钥都不能证明其来自已购、未篡改 App。未接入 Apple App
    // Attest + 服务端交易验证前必须拒绝，避免脚本注册 Host 盗刷免费额度。
    if (env.HOST_REGISTRATION_ENABLED !== "true") return json({ code: "host_registration_unavailable" }, 503);
    const payload = await requestJSON<{ publicKey: string; keyID: string; attestation: string; challenge: string; signedTransaction: string }>(request).catch(() => null);
    const raw = payload && expectString(payload.publicKey, 128) ? safeFromB64(payload.publicKey) : null;
    const challenge = payload && expectString(payload.challenge, 64) ? safeFromB64(payload.challenge) : null;
    if (!payload || !raw || raw.byteLength !== 65 || raw[0] !== 4 || !challenge || challenge.byteLength !== 32 || !expectString(payload.keyID, 256) || !expectString(payload.attestation, 32768) || !expectString(payload.signedTransaction, 32768)) return json({ code: "invalid_request" }, 400);
    const consumed = await env.DB.prepare("DELETE FROM host_challenges WHERE purpose='register' AND challenge=? AND bound_public_key=? AND expires_at>? AND consumed_at IS NULL").bind(challenge, raw, now()).run();
    if (!consumed.meta.changes) return json({ code: "invalid_challenge" }, 401);
    let attestation: Awaited<ReturnType<typeof verifyAttestation>>;
    try {
      const challengeBytes = new Uint8Array(challenge.byteLength); challengeBytes.set(challenge);
      const challengeHash = new Uint8Array(await crypto.subtle.digest("SHA-256", challengeBytes));
      attestation = await verifyAttestation({ appId: env.APP_ATTEST_APP_ID, developmentEnv: env.APP_ATTEST_DEVELOPMENT === "true" }, payload.keyID, challengeHash, payload.attestation);
    } catch (error) {
      console.warn("web_guest_host_registration_rejected", { stage: "app_attest", reason: error instanceof Error ? error.name : "unknown" });
      return json({ code: "app_attest_verification_failed" }, 401);
    }
    try {
      const purchase = await verifyHostPurchase(env, payload.signedTransaction);
      const hostID = id();
      await env.DB.prepare("INSERT INTO hosts(id,public_key,app_attest_key_id,app_attest_public_key_pem,app_attest_sign_count,transaction_id,original_transaction_id,subscription_expires_at,created_at,registered_at,last_attested_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").bind(hostID, raw, payload.keyID, attestation.publicKeyPem, attestation.signCount, purchase.transactionID, purchase.originalTransactionID, purchase.expiresAt, now(), now(), now()).run();
      return json({ hostID }, 201);
    } catch (error) {
      // 仅记录验证阶段和异常类型；绝不记录 StoreKit JWS、Host 公钥或 IP。
      console.warn("web_guest_host_registration_rejected", { stage: "storekit_purchase", reason: error instanceof Error ? error.name : "unknown" });
      return json({ code: "storekit_verification_failed" }, 401);
    }
  }
  if (path === "/v1/host/assertion-challenge" && request.method === "POST") {
    // 此端点仅用安装 P-256 密钥认证；它的职责是签发下一条已经预计算 canonical
    // 请求摘要所专用的 App Attest challenge，不能以自身的 assertion 替代目标请求。
    const data = await request.arrayBuffer(); const authenticated = await authenticateHost(request, env, data);
    if (!authenticated) return json({ code: "unauthorized" }, 401);
    const retryAfter = await consumeHostRateLimit(env, "challenge", authenticated.host.id, limits.hostChallenge);
    if (retryAfter !== null) return tooManyRequests(retryAfter);
    const payload = (() => { try { return JSON.parse(new TextDecoder().decode(data)) as { requestDigest?: string } } catch { return null } })();
    const requestDigest = payload && expectString(payload.requestDigest, 64);
    if (!requestDigest || !/^[a-f0-9]{64}$/.test(requestDigest)) return json({ code: "invalid_request" }, 400);
    const challenge = crypto.getRandomValues(new Uint8Array(32)); const expiresAt = now() + 60;
    await env.DB.batch([
      env.DB.prepare("DELETE FROM host_challenges WHERE expires_at<=?").bind(now()),
      env.DB.prepare("INSERT INTO host_challenges(id,purpose,challenge,expires_at,bound_host_id,bound_public_key,request_digest) VALUES(?,?,?,?,?,?,?)").bind(id(), "assert", challenge, expiresAt, authenticated.host.id, authenticated.host.public_key, requestDigest)
    ]);
    return json({ challenge: b64(challenge.buffer), expiresAt }, 201);
  }
  if (path === "/v1/host/identity" && request.method === "POST") {
    // 仅用于客户端在敏感请求 401 后区分“Host 已不存在”和“assertion 瞬时失败”。
    // 存在的 Host 必须以登记的 P-256 私钥签名才能得到确认；未知 ID 返回 410，
    // 不接受 assertion，也不提供任何 Host、订阅或 Session 数据。
    const hostID = request.headers.get("x-evb-host");
    if (!hostID || !/^[0-9a-f-]{36}$/i.test(hostID)) return ended();
    const exists = await env.DB.prepare("SELECT 1 FROM hosts WHERE id=?").bind(hostID).first();
    if (!exists) return ended();
    const data = await request.arrayBuffer();
    const authenticated = await authenticateHost(request, env, data);
    return authenticated ? json({ accepted: true }) : json({ code: "unauthorized" }, 401);
  }
  // 已注册设备每次开启新会话前以新的 Apple 已签名交易刷新订阅到期时间。
  if (path === "/v1/host/subscription" && request.method === "POST") {
    const { data, hostID } = await hostBody(request, env);
    if (!hostID) return json({ code: "unauthorized" }, 401);
    const payload = (() => { try { return JSON.parse(new TextDecoder().decode(data)) as { signedTransaction?: string } } catch { return null } })();
    const signedTransaction = payload && expectString(payload.signedTransaction, 32768);
    if (!signedTransaction) return json({ code: "invalid_request" }, 400);
    try {
      const purchase = await verifyHostPurchase(env, signedTransaction);
      await env.DB.prepare("UPDATE hosts SET transaction_id=?,original_transaction_id=?,subscription_expires_at=? WHERE id=?").bind(purchase.transactionID, purchase.originalTransactionID, purchase.expiresAt, hostID).run();
      return json({ active: true, expiresAt: purchase.expiresAt });
    } catch { return json({ code: "subscription_inactive" }, 403); }
  }
  if (path === "/v1/host/sessions" && request.method === "POST") {
    const { data, hostID } = await hostBody(request, env);
    if (!hostID) { console.warn("web_guest_host_rejected", { stage: "create_session_auth" }); return json({ code: "unauthorized" }, 401); }
    const retryAfter = await consumeHostRateLimit(env, "sensitive", hostID, limits.hostSensitive);
    if (retryAfter !== null) return tooManyRequests(retryAfter);
    const payload = (() => { try { return JSON.parse(new TextDecoder().decode(data)) as { maxBytes?: unknown; previousSessionID?: unknown } } catch { return null } })();
    const suppliedMaxBytes = payload?.maxBytes;
    const previousSessionID = payload?.previousSessionID;
    if (!payload || (suppliedMaxBytes !== undefined && (!Number.isSafeInteger(suppliedMaxBytes) || typeof suppliedMaxBytes !== "number" || suppliedMaxBytes < 1)) || (previousSessionID !== undefined && (typeof previousSessionID !== "string" || !/^[0-9a-f-]{36}$/i.test(previousSessionID)))) return json({ code: "invalid_request" }, 400);
    const host = await env.DB.prepare("SELECT subscription_expires_at FROM hosts WHERE id=?").bind(hostID).first<{ subscription_expires_at: number | null }>();
    if (!host || !host.subscription_expires_at || host.subscription_expires_at <= now()) return json({ code: "subscription_inactive" }, 403);
    const requestedBytes = typeof suppliedMaxBytes === "number" ? suppliedMaxBytes : Number(env.MAX_EVENT_BYTES);
    const limit = Math.min(requestedBytes, Number(env.MAX_EVENT_BYTES));
    // 客户端恢复本地/服务端漂移时需要服务端证明“它保存的旧 Session 确已结束”。
    // 证明仅针对同一已认证 Host，未知或其它 Host 的 ID 一律为 false，避免对象探测。
    const previousSessionEnded = typeof previousSessionID === "string"
      ? Boolean(await env.DB.prepare("SELECT 1 FROM sessions WHERE id=? AND host_id=? AND state IN ('revoked','expired')").bind(previousSessionID, hostID).first())
      : false;
    // 先收敛这个 Host 的过期记录。创建 Session 是可安全重试的幂等操作：若已有
    // 未到期 live Session，返回原 QR；并发请求则由 `sessions_one_live_per_host`
    // 兜底为最多一条，冲突后再次读取同一条 Session。
    await env.DB.prepare("UPDATE sessions SET state='expired' WHERE host_id=? AND state='live' AND expires_at<=?").bind(hostID, now()).run();
    const current = await env.DB.prepare("SELECT id,public_slug,expires_at FROM sessions WHERE host_id=? AND state='live' AND expires_at>? LIMIT 1").bind(hostID, now()).first<{ id: string; public_slug: string; expires_at: number }>();
    if (current) return json({ sessionID: current.id, joinURL: `${env.GUEST_ORIGIN}/join/${current.public_slug}`, expiresAt: current.expires_at, previousSessionEnded }, 200);
    const sessionID = id(); const slug = b64(crypto.getRandomValues(new Uint8Array(32)).buffer); const expires = now() + Number(env.SESSION_TTL_SECONDS);
    try {
      const inserted = await env.DB.prepare("INSERT INTO sessions(id,host_id,public_slug,state,revoke_version,expires_at,max_bytes,created_at) SELECT ?,?,?, 'live',0,?,?,? WHERE (SELECT COUNT(*) FROM sessions WHERE state='live' AND expires_at>?)<?").bind(sessionID, hostID, slug, expires, limit, now(), now(), Number(env.MAX_ACTIVE_SESSIONS)).run();
      if (inserted.meta.changes) return json({ sessionID, joinURL: `${env.GUEST_ORIGIN}/join/${slug}`, expiresAt: expires, previousSessionEnded }, 201);
    } catch {
      // 同一 Host 的另一台已登录设备可能刚好赢得唯一索引；随后读取即可保持幂等。
    }
    const winner = await env.DB.prepare("SELECT id,public_slug,expires_at FROM sessions WHERE host_id=? AND state='live' AND expires_at>? LIMIT 1").bind(hostID, now()).first<{ id: string; public_slug: string; expires_at: number }>();
    if (winner) return json({ sessionID: winner.id, joinURL: `${env.GUEST_ORIGIN}/join/${winner.public_slug}`, expiresAt: winner.expires_at, previousSessionEnded }, 200);
    return json({ code: "web_guest_capacity_reached", message: "Web guest capacity is temporarily full. Try again later." }, 503, { "retry-after": "300" });
  }
  if (parts[0] === "v1" && parts[1] === "host" && parts[2] === "sessions" && parts[4] === "revoke" && request.method === "POST") {
    const { data, hostID, authFailure } = await hostBody(request, env); if (!hostID || data.byteLength) return unauthorizedAt("revoke", authFailure); const retryAfter = await consumeHostRateLimit(env, "sensitive", hostID, limits.hostSensitive); if (retryAfter !== null) return tooManyRequests(retryAfter); const sessionID = parts[3]; const result = await env.DB.prepare("UPDATE sessions SET state='revoked', revoke_version=revoke_version+1, revoked_at=? WHERE id=? AND host_id=? AND state='live'").bind(now(), sessionID, hostID).run(); if (!result.meta.changes) { const existing = await env.DB.prepare("SELECT state,revoke_version FROM sessions WHERE id=? AND host_id=?").bind(sessionID, hostID).first<Pick<Session, "state" | "revoke_version">>(); if (!existing || existing.state !== "revoked") return ended(); return json({ revoked: true, revokeVersion: existing.revoke_version }); } const session = await env.DB.prepare("SELECT revoke_version FROM sessions WHERE id=?").bind(sessionID).first<{ revoke_version: number }>(); return json({ revoked: true, revokeVersion: session!.revoke_version });
  }
  if (parts[0] === "v1" && parts[1] === "guest" && parts[3] === "bootstrap" && request.method === "GET") {
    if (!isGuestOrigin(request, env)) return json({ code: "invalid_origin" }, 403); const ipHash = await visitorIPHash(request, env); if (!ipHash) return json({ code: "service_unavailable" }, 503); const retryAfter = await consumeAllRateLimits(env, [{ scope: `bootstrap:ip:${ipHash}`, ...limits.bootstrapIP }]); if (retryAfter !== null) return withGuestCORS(tooManyRequests(retryAfter), request, env); const session = await liveSession(env, parts[2]); if (!session) return withGuestCORS(await guestLinkEnded(env, parts[2]), request, env); return withGuestCORS(json({ maxAudioBytes: Number(env.MAX_AUDIO_BYTES), maxPhotoBytes: Number(env.MAX_PHOTO_BYTES), expiresAt: session.expires_at }), request, env);
  }
  // Pages 边缘函数在返回静态 Guest 页面前只查询会话是否仍可访问。该查询不返回
  // 活动、媒体或配额数据，也不依赖浏览器 IP；实际 bootstrap/上传仍保持 Origin、
  // IP 限流和 CORS 门禁，避免 Host revoke 后二维码继续展示录音页面。
  if (parts[0] === "v1" && parts[1] === "guest" && parts[3] === "access" && request.method === "GET") {
    const session = await liveSession(env, parts[2]);
    return session ? empty(204) : await guestLinkEnded(env, parts[2]);
  }
  if (parts[0] === "v1" && parts[1] === "guest" && parts[3] === "capabilities" && request.method === "POST") {
    if (!isGuestOrigin(request, env)) return json({ code: "invalid_origin" }, 403); const ipHash = await visitorIPHash(request, env); if (!ipHash) return json({ code: "service_unavailable" }, 503); const session = await liveSession(env, parts[2]); if (!session) return withGuestCORS(await guestLinkEnded(env, parts[2]), request, env); const retryAfter = await consumeAllRateLimits(env, [{ scope: `capability:ip:${ipHash}`, ...limits.capabilityIP }, { scope: `capability:session:${session.id}`, ...limits.capabilitySession }]); if (retryAfter !== null) return withGuestCORS(tooManyRequests(retryAfter), request, env); const payload = await requestJSON<{ kind: "audio" | "photo" }>(request).catch(() => null); if (!payload || (payload.kind !== "audio" && payload.kind !== "photo")) return withGuestCORS(json({ code: "invalid_request" }, 400), request, env); const capID = id(); const nonce = b64(crypto.getRandomValues(new Uint8Array(32)).buffer); const maxBytes = payload.kind === "audio" ? Number(env.MAX_AUDIO_BYTES) : Number(env.MAX_PHOTO_BYTES); await env.DB.prepare("INSERT INTO capabilities(id,session_id,nonce,revoke_version,media_kind,max_bytes,expires_at) VALUES(?,?,?,?,?,?,?)").bind(capID, session.id, nonce, session.revoke_version, payload.kind, maxBytes, now() + 600).run(); return withGuestCORS(json({ capability: `${capID}.${nonce}`, expiresAt: now() + 600, maxBytes }), request, env);
  }
  if (parts[0] === "v1" && parts[1] === "guest" && parts[2] === "uploads" && parts.length === 4 && request.method === "PUT") {
    if (!isGuestOrigin(request, env)) return json({ code: "invalid_origin" }, 403); const ipHash = await visitorIPHash(request, env); if (!ipHash) return json({ code: "service_unavailable" }, 503); const [capID, nonce] = (request.headers.get("authorization") || "").replace("Bearer ", "").split("."); const cap = await env.DB.prepare("SELECT c.*,s.state,s.revoke_version AS current_revoke_version,s.expires_at AS session_expires FROM capabilities c JOIN sessions s ON s.id=c.session_id WHERE c.id=? AND c.nonce=?").bind(capID, nonce).first<Capability>(); if (!cap || cap.consumed_at || cap.upload_state !== "issued" || cap.expires_at <= now() || cap.state !== "live" || cap.revoke_version !== cap.current_revoke_version || cap.session_expires <= now()) return ended(); const retryAfter = await consumeAllRateLimits(env, [{ scope: `upload:ip:${ipHash}`, ...limits.uploadIP }, { scope: `upload:session:${cap.session_id}`, ...limits.uploadSession }, { scope: `upload:capability:${cap.id}`, maximum: 1, windowSeconds: 600 }]); if (retryAfter !== null) return withGuestCORS(tooManyRequests(retryAfter), request, env); const declaredLength = request.headers.get("content-length"); if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) < 1 || Number(declaredLength) > cap.max_bytes)) return withGuestCORS(json({ code: "invalid_size" }, 413), request, env); const lease = await acquireUploadLease(env, cap.session_id, cap.id, ipHash); if (!lease) return withGuestCORS(tooManyRequests(15), request, env); const claimed = await env.DB.prepare("UPDATE capabilities SET upload_state='uploading' WHERE id=? AND upload_state='issued' AND consumed_at IS NULL").bind(cap.id).run(); if (!claimed.meta.changes) { await releaseUploadLease(env, lease); return ended(); } try { const raw = new Uint8Array(await request.arrayBuffer()); const hasInvalidSize = raw.byteLength < 1 || raw.byteLength > cap.max_bytes || (declaredLength !== null && raw.byteLength !== Number(declaredLength)); if (hasInvalidSize || !mediaMagic(cap.media_kind, raw)) { await env.DB.prepare("UPDATE capabilities SET upload_state='issued' WHERE id=? AND upload_state='uploading'").bind(cap.id).run(); return withGuestCORS(json({ code: hasInvalidSize ? "invalid_size" : "invalid_media" }, hasInvalidSize ? 413 : 415), request, env); } const checksum = await sha256(raw.buffer); const objectKey = `quarantine/${cap.session_id}/${cap.id}`; await env.MEDIA.put(objectKey, raw, { httpMetadata: { contentType: cap.media_kind === "photo" ? "image/jpeg" : "audio/mp4" }, customMetadata: { sha256: checksum, kind: cap.media_kind } }); const committed = await env.DB.prepare("UPDATE capabilities SET consumed_at=?,upload_state='uploaded' WHERE id=? AND upload_state='uploading'").bind(now(), cap.id).run(); if (!committed.meta.changes) { await env.MEDIA.delete(objectKey); return ended(); } return withGuestCORS(json({ uploadID: cap.id, sha256: checksum }, 201), request, env); } catch { await env.MEDIA.delete(`quarantine/${cap.session_id}/${cap.id}`); await env.DB.prepare("UPDATE capabilities SET upload_state='issued' WHERE id=? AND upload_state='uploading'").bind(cap.id).run(); return withGuestCORS(json({ code: "upload_failed" }, 503), request, env); } finally { await releaseUploadLease(env, lease); }
  }
  if (parts[0] === "v1" && parts[1] === "guest" && parts[3] === "finalize" && request.method === "POST") {
    if (!isGuestOrigin(request, env)) return json({ code: "invalid_origin" }, 403); const ipHash = await visitorIPHash(request, env); if (!ipHash) return json({ code: "service_unavailable" }, 503); const session = await liveSession(env, parts[2]); if (!session) return withGuestCORS(await guestLinkEnded(env, parts[2]), request, env); const retryAfter = await consumeAllRateLimits(env, [{ scope: `finalize:ip:${ipHash}`, ...limits.finalizeIP }, { scope: `finalize:session:${session.id}`, ...limits.finalizeSession }]); if (retryAfter !== null) return withGuestCORS(tooManyRequests(retryAfter), request, env);
    const payload = await requestJSON<{ audioUploadID: string; photoUploadIDs?: string[] }>(request).catch(() => null); const ids = payload && [payload.audioUploadID, ...(payload.photoUploadIDs || [])];
    if (!ids || new Set(ids).size !== ids.length || !expectString(payload!.audioUploadID, 80) || ids.length > 7 || ids.some(value => !expectString(value, 80))) return withGuestCORS(json({ code: "invalid_request" }, 400), request, env);
    const statement = `SELECT id,session_id,revoke_version,media_kind,consumed_at,upload_state FROM capabilities WHERE id IN (${ids.map(() => "?").join(",")})`; const caps = await env.DB.prepare(statement).bind(...ids).all<Pick<Capability, "id" | "session_id" | "revoke_version" | "media_kind" | "consumed_at" | "upload_state">>();
    if (caps.results.length !== ids.length || caps.results.some(cap => cap.session_id !== session.id || cap.revoke_version !== session.revoke_version || !cap.consumed_at || cap.upload_state !== "uploaded") || caps.results.filter(cap => cap.media_kind === "audio").length !== 1) return ended();
    // 一组 capability 只能被一个 finalize 请求占用；避免并发生成两条 submission。
    const claim = await env.DB.prepare(`UPDATE capabilities SET upload_state='finalizing' WHERE id IN (${ids.map(() => "?").join(",")}) AND upload_state='uploaded'`).bind(...ids).run();
    if (claim.meta.changes !== ids.length) return ended();
    const objects = await Promise.all(caps.results.map(async cap => ({ cap, object: await env.MEDIA.head(`quarantine/${session.id}/${cap.id}`) }))); if (objects.some(item => !item.object)) { await env.DB.prepare(`UPDATE capabilities SET upload_state='uploaded' WHERE id IN (${ids.map(() => "?").join(",")}) AND upload_state='finalizing'`).bind(...ids).run(); return withGuestCORS(json({ code: "invalid_media" }, 415), request, env); }
    const total = objects.reduce((sum, item) => sum + item.object!.size, 0); const reservation = await env.DB.prepare("UPDATE sessions SET used_bytes=used_bytes+?, submission_count=submission_count+1 WHERE id=? AND state='live' AND revoke_version=? AND expires_at>? AND used_bytes+?<=max_bytes AND submission_count<? AND EXISTS (SELECT 1 FROM hosts WHERE id=sessions.host_id AND deleting_at IS NULL)").bind(total, session.id, session.revoke_version, now(), total, Number(env.MAX_SUBMISSIONS_PER_SESSION)).run(); if (!reservation.meta.changes) { await env.DB.prepare(`UPDATE capabilities SET upload_state='uploaded' WHERE id IN (${ids.map(() => "?").join(",")}) AND upload_state='finalizing'`).bind(...ids).run(); const refreshed = await env.DB.prepare("SELECT state,revoke_version,expires_at,used_bytes,max_bytes,submission_count FROM sessions WHERE id=?").bind(session.id).first<Session>(); if (refreshed?.state === "live" && refreshed.revoke_version === session.revoke_version && refreshed.expires_at > now() && (refreshed.used_bytes >= refreshed.max_bytes || refreshed.submission_count >= Number(env.MAX_SUBMISSIONS_PER_SESSION))) return withGuestCORS(capacityExhausted(), request, env); return ended(); }
    const submissionID = id(); const receipt = guestReceipt(); const audio = objects.find(item => item.cap.media_kind === "audio")!; const photos = objects.filter(item => item.cap.media_kind === "photo"); const audioKey = `pending/${session.id}/${submissionID}/${audio.cap.id}`; const photoManifest = photos.map(item => ({ key: `pending/${session.id}/${submissionID}/${item.cap.id}`, bytes: item.object!.size, sha256: item.object!.customMetadata?.sha256 || "" }));
    try {
      // 先复制全部对象，所有对象完成后才把 submission 公开为 ready，Host 不会看到半成品。
      await Promise.all(objects.map(async item => { const source = `quarantine/${session.id}/${item.cap.id}`; const staged = await env.MEDIA.get(source); if (!staged) throw new Error("quarantine_object_missing"); const destination = `pending/${session.id}/${submissionID}/${item.cap.id}`; await env.MEDIA.put(destination, staged.body, { httpMetadata: staged.httpMetadata, customMetadata: staged.customMetadata }); await env.MEDIA.delete(source); }));
      const submittedAt = now();
      await env.DB.batch([env.DB.prepare("INSERT INTO submissions(id,session_id,state,audio_key,audio_bytes,audio_sha256,photo_manifest,guest_receipt,created_at,finalized_at,expires_at) VALUES(?,?, 'ready',?,?,?,?,?,?,?,?)").bind(submissionID, session.id, audioKey, audio.object!.size, audio.object!.customMetadata?.sha256 || "", JSON.stringify(photoManifest), receipt, submittedAt, submittedAt, submittedAt + 86_400), env.DB.prepare(`UPDATE capabilities SET upload_state='finalized' WHERE id IN (${ids.map(() => "?").join(",")}) AND upload_state='finalizing'`).bind(...ids)]);
      return withGuestCORS(json({ submissionID, receipt, state: "pending_host" }, 201), request, env);
    } catch {
      await env.MEDIA.delete([audioKey, ...photoManifest.map(photo => photo.key)]);
      await env.DB.batch([env.DB.prepare("UPDATE sessions SET used_bytes=MAX(0,used_bytes-?),submission_count=MAX(0,submission_count-1) WHERE id=?").bind(total, session.id), env.DB.prepare(`UPDATE capabilities SET upload_state='uploaded' WHERE id IN (${ids.map(() => "?").join(",")}) AND upload_state='finalizing'`).bind(...ids)]);
      return withGuestCORS(json({ code: "finalize_failed" }, 503), request, env);
    }
  }
  if (parts[0] === "v1" && parts[1] === "guest" && parts[3] === "receipts" && parts.length === 5 && request.method === "GET") {
    const slug = parts[2]; const receipt = parts[4];
    // receipt 与其二维码 slug 同时匹配，并仅在正式 Pages Origin 下返回 ACK 状态。
    if (!isGuestOrigin(request, env) || !/^[A-Za-z0-9_-]{32,}$/.test(slug) || !/^[A-Za-z0-9_-]{43}$/.test(receipt)) return withGuestCORS(ended(), request, env);
    const submission = await env.DB.prepare("SELECT sub.state FROM submissions sub JOIN sessions s ON s.id=sub.session_id WHERE sub.guest_receipt=? AND s.public_slug=?").bind(receipt, slug).first<{ state: Submission["state"] }>();
    if (!submission) return withGuestCORS(ended(), request, env);
    return withGuestCORS(json({ state: submission.state === "acked" ? "saved_by_host" : "pending_host" }), request, env);
  }
  if (parts[0] === "v1" && parts[1] === "host" && parts[2] === "sessions" && parts[4] === "submissions" && request.method === "GET") {
    const { data, hostID, authFailure } = await hostBody(request, env); if (!hostID || data.byteLength) return unauthorizedAt("list", authFailure); const retryAfter = await consumeHostRateLimit(env, "sensitive", hostID, limits.hostSensitive); if (retryAfter !== null) return tooManyRequests(retryAfter); const session = await env.DB.prepare("SELECT id FROM sessions WHERE id=? AND host_id=?").bind(parts[3], hostID).first(); if (!session) return ended(); const result = await env.DB.prepare("SELECT id,audio_bytes,audio_sha256,photo_manifest,created_at FROM submissions WHERE session_id=? AND state='ready' AND expires_at>? ORDER BY created_at LIMIT 20").bind(parts[3], now()).all<Pick<Submission, "id" | "audio_bytes" | "audio_sha256" | "photo_manifest" | "created_at">>(); return json({ submissions: result.results.map(publicSubmission) });
  }
  if (parts[0] === "v1" && parts[1] === "host" && parts[2] === "submissions" && parts[4] === "media" && request.method === "GET") {
    const { data, hostID, authFailure } = await hostBody(request, env); if (!hostID || data.byteLength) return unauthorizedAt("media", authFailure); const retryAfter = await consumeHostRateLimit(env, "sensitive", hostID, limits.hostSensitive); if (retryAfter !== null) return tooManyRequests(retryAfter); const submission = await env.DB.prepare("SELECT sub.*,s.host_id FROM submissions sub JOIN sessions s ON s.id=sub.session_id WHERE sub.id=?").bind(parts[3]).first<Submission>(); if (!submission || submission.host_id !== hostID || submission.state !== "ready") return ended(); if (submission.expires_at <= now()) return submissionExpired(); const photoIndex = url.searchParams.get("photoIndex"); const photos = parsePhotos(submission.photo_manifest); const requestedKey = photoIndex === null ? submission.audio_key : (/^(0|[1-5])$/.test(photoIndex) ? photos[Number(photoIndex)]?.key : undefined); if (!requestedKey) return ended(); const object = await env.MEDIA.get(requestedKey); if (!object) return ended(); return new Response(object.body, { headers: securityHeaders({ "content-type": object.httpMetadata?.contentType || "application/octet-stream", "content-length": String(object.size), "cache-control": "no-store" }) });
  }
  if (parts[0] === "v1" && parts[1] === "host" && parts[2] === "submissions" && parts[4] === "ack" && request.method === "POST") {
    const { data, hostID, authFailure } = await hostBody(request, env); if (!hostID || data.byteLength) return unauthorizedAt("ack", authFailure); const retryAfter = await consumeHostRateLimit(env, "sensitive", hostID, limits.hostSensitive); if (retryAfter !== null) return tooManyRequests(retryAfter); const submission = await env.DB.prepare("SELECT sub.*,s.host_id FROM submissions sub JOIN sessions s ON s.id=sub.session_id WHERE sub.id=?").bind(parts[3]).first<Submission>(); if (!submission || submission.host_id !== hostID) return ended(); if (submission.state === "acked") return json({ acknowledged: true }); if (submission.state !== "ready") return json({ code: "invalid_state" }, 409); if (submission.expires_at <= now()) return submissionExpired(); const changed = await env.DB.prepare("UPDATE submissions SET state='acked',acked_at=? WHERE id=? AND state='ready' AND expires_at>?").bind(now(), submission.id, now()).run(); if (!changed.meta.changes) return submissionExpired(); await env.MEDIA.delete([submission.audio_key, ...parsePhotos(submission.photo_manifest).map(photo => photo.key)]); return json({ acknowledged: true });
  }
  return json({ code: "not_found" }, 404);
}, async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
  // 每五分钟扫描一次；直接访问同样按 expires_at 拒绝，保证超过 24 小时不能再下载。
  const purged = await purgeExpiredUnacknowledgedMedia(env);
  console.log("web_guest_expired_media_purged", { purged });
} };
