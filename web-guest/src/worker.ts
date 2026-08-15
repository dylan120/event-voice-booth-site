import { verifyAttestation } from "@bradford-tech/supabase-integrity-attest/attestation";
import { verifyAssertion } from "@bradford-tech/supabase-integrity-attest/assertion";
import { Environment, SignedDataVerifier } from "@studium-ignotum/app-store-server-library";

export interface Env { DB: D1Database; MEDIA: R2Bucket; GUEST_ORIGIN: string; HOST_ORIGIN: string; MAX_EVENT_BYTES: string; MAX_AUDIO_BYTES: string; MAX_PHOTO_BYTES: string; SESSION_TTL_SECONDS: string; MAX_ACTIVE_SESSIONS: string; MAX_SUBMISSIONS_PER_SESSION: string; HOST_REGISTRATION_ENABLED: string; APP_ATTEST_APP_ID: string; APP_STORE_BUNDLE_ID: string; APP_APPLE_ID: string; IP_HASH_SALT?: string }
type Session = { id: string; host_id: string; public_slug: string; state: "live" | "revoked" | "expired"; revoke_version: number; expires_at: number; max_bytes: number; used_bytes: number; submission_count: number; subscription_expires_at?: number | null }
type AttestedHost = { id: string; public_key: ArrayBuffer | Uint8Array; app_attest_key_id: string | null; app_attest_public_key_pem: string | null; app_attest_sign_count: number; subscription_expires_at?: number | null }
type RateLimit = { scope: string; maximum: number; windowSeconds: number }
type UploadLease = { id: string; sessionID: string }
type Capability = { id: string; session_id: string; revoke_version: number; media_kind: "audio" | "photo"; max_bytes: number; expires_at: number; consumed_at: number | null; upload_state: "issued" | "uploading" | "uploaded" | "finalizing" | "finalized"; state: Session["state"]; current_revoke_version: number; session_expires: number }
type StoredPhoto = { key: string; bytes: number; sha256: string }
type Submission = { id: string; session_id: string; state: "uploading" | "ready" | "claimed" | "acked" | "discarded"; audio_key: string; audio_bytes: number; audio_sha256: string; photo_manifest: string; guest_receipt: string | null; created_at: number; expires_at: number; host_id: string }
const limits = {
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
/** 新投稿需要 Host 当前有效订阅；过期后仍允许已认证 Host 导入、ACK 与 revoke 收尾。 */
async function liveSession(env: Env, slug: string) {
  const s = await env.DB.prepare("SELECT s.*,h.subscription_expires_at FROM sessions s JOIN hosts h ON h.id=s.host_id WHERE s.public_slug=?").bind(slug).first<Session>();
  return s && s.state === "live" && s.expires_at > now() && (s.subscription_expires_at ?? 0) > now() ? s : null;
}
function ended() { return json({ code: "ended_or_invalid", message: "This guest link is no longer available." }, 410) }
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

/** 无账号 Host 以服务端已验证的身份为键限速，避免伪造 Header 或 IP 造成误伤。 */
async function consumeHostRateLimit(env: Env, hostID: string, limit: Omit<RateLimit, "scope">): Promise<number | null> {
  return consumeRateLimit(env, { ...limit, scope: `host:${hostID}` });
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
async function hostBody(request: Request, env: Env) { const data = await request.arrayBuffer(); return await authenticateAttestedHost(request, env, data) ?? { data, hostID: null } }
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
  const legacyLifetime = transaction.productId === "com.eventvoicebooth.host.lifetime";
  const monthly = transaction.productId === "com.eventvoicebooth.host.monthly";
  const expiresAt = legacyLifetime ? 253402300799 : Math.floor((transaction.expiresDate || 0) / 1000);
  if (transaction.bundleId !== env.APP_STORE_BUNDLE_ID || (!legacyLifetime && !monthly) || (transaction.environment !== Environment.PRODUCTION && transaction.environment !== Environment.SANDBOX) || transaction.revocationDate || !transaction.transactionId || !transaction.originalTransactionId || expiresAt <= now()) throw new Error("invalid_purchase");
  return { transactionID: transaction.transactionId, originalTransactionID: transaction.originalTransactionId, expiresAt };
}

export default { async fetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url); const path = url.pathname; const parts = path.split("/").filter(Boolean);
  // 仅正式 Guest Pages 可取得 CORS 预检许可；其它站点不能借浏览器发起写入。
  if (request.method === "OPTIONS") return isGuestOrigin(request, env) ? withGuestCORS(empty(204), request, env) : json({ code: "invalid_origin" }, 403);
  if (path === "/health") return json({ ok: true });
  if (path === "/v1/hosts/registration-challenge" && request.method === "POST") {
    if (env.HOST_REGISTRATION_ENABLED !== "true") return json({ code: "host_registration_unavailable" }, 503);
    const ipHash = await visitorIPHash(request, env); if (!ipHash) return json({ code: "service_unavailable" }, 503);
    const retryAfter = await consumeAllRateLimits(env, [{ scope: `host-register:ip:${ipHash}`, maximum: 3, windowSeconds: 3_600 }]); if (retryAfter !== null) return tooManyRequests(retryAfter);
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
    try {
      const challengeBytes = new Uint8Array(challenge.byteLength); challengeBytes.set(challenge);
      const challengeHash = new Uint8Array(await crypto.subtle.digest("SHA-256", challengeBytes));
      const attestation = await verifyAttestation({ appId: env.APP_ATTEST_APP_ID }, payload.keyID, challengeHash, payload.attestation);
      const purchase = await verifyHostPurchase(env, payload.signedTransaction);
      const hostID = id();
      await env.DB.prepare("INSERT INTO hosts(id,public_key,app_attest_key_id,app_attest_public_key_pem,app_attest_sign_count,transaction_id,original_transaction_id,subscription_expires_at,created_at,registered_at,last_attested_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").bind(hostID, raw, payload.keyID, attestation.publicKeyPem, attestation.signCount, purchase.transactionID, purchase.originalTransactionID, purchase.expiresAt, now(), now(), now()).run();
      return json({ hostID }, 201);
    } catch { return json({ code: "host_verification_failed" }, 401); }
  }
  if (path === "/v1/host/assertion-challenge" && request.method === "POST") {
    // 此端点仅用安装 P-256 密钥认证；它的职责是签发下一条已经预计算 canonical
    // 请求摘要所专用的 App Attest challenge，不能以自身的 assertion 替代目标请求。
    const data = await request.arrayBuffer(); const authenticated = await authenticateHost(request, env, data);
    if (!authenticated) return json({ code: "unauthorized" }, 401);
    const retryAfter = await consumeHostRateLimit(env, authenticated.host.id, limits.hostChallenge);
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
    const retryAfter = await consumeHostRateLimit(env, hostID, limits.hostSensitive);
    if (retryAfter !== null) return tooManyRequests(retryAfter);
    const payload = (() => { try { return JSON.parse(new TextDecoder().decode(data)) as { maxBytes?: unknown } } catch { return null } })();
    const suppliedMaxBytes = payload?.maxBytes;
    if (!payload || (suppliedMaxBytes !== undefined && (!Number.isSafeInteger(suppliedMaxBytes) || typeof suppliedMaxBytes !== "number" || suppliedMaxBytes < 1))) return json({ code: "invalid_request" }, 400);
    const host = await env.DB.prepare("SELECT subscription_expires_at FROM hosts WHERE id=?").bind(hostID).first<{ subscription_expires_at: number | null }>();
    if (!host || !host.subscription_expires_at || host.subscription_expires_at <= now()) return json({ code: "subscription_inactive" }, 403);
    const requestedBytes = typeof suppliedMaxBytes === "number" ? suppliedMaxBytes : Number(env.MAX_EVENT_BYTES);
    const limit = Math.min(requestedBytes, Number(env.MAX_EVENT_BYTES)); const sessionID = id(); const slug = b64(crypto.getRandomValues(new Uint8Array(32)).buffer); const expires = now() + Number(env.SESSION_TTL_SECONDS); const inserted = await env.DB.prepare("INSERT INTO sessions(id,host_id,public_slug,state,revoke_version,expires_at,max_bytes,created_at) SELECT ?,?,?, 'live',0,?,?,? WHERE (SELECT COUNT(*) FROM sessions WHERE state='live' AND expires_at>?)<?").bind(sessionID, hostID, slug, expires, limit, now(), now(), Number(env.MAX_ACTIVE_SESSIONS)).run(); if (!inserted.meta.changes) return json({ code: "web_guest_capacity_reached", message: "Web guest capacity is temporarily full. Try again later." }, 503, { "retry-after": "300" }); return json({ sessionID, joinURL: `${env.GUEST_ORIGIN}/join/${slug}`, expiresAt: expires }, 201);
  }
  if (parts[0] === "v1" && parts[1] === "host" && parts[2] === "sessions" && parts[4] === "revoke" && request.method === "POST") {
    const { data, hostID } = await hostBody(request, env); if (!hostID || data.byteLength) return json({ code: "unauthorized" }, 401); const retryAfter = await consumeHostRateLimit(env, hostID, limits.hostSensitive); if (retryAfter !== null) return tooManyRequests(retryAfter); const sessionID = parts[3]; const result = await env.DB.prepare("UPDATE sessions SET state='revoked', revoke_version=revoke_version+1, revoked_at=? WHERE id=? AND host_id=? AND state='live'").bind(now(), sessionID, hostID).run(); if (!result.meta.changes) return ended(); const session = await env.DB.prepare("SELECT revoke_version FROM sessions WHERE id=?").bind(sessionID).first<{ revoke_version: number }>(); return json({ revoked: true, revokeVersion: session!.revoke_version });
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
    const total = objects.reduce((sum, item) => sum + item.object!.size, 0); const reservation = await env.DB.prepare("UPDATE sessions SET used_bytes=used_bytes+?, submission_count=submission_count+1 WHERE id=? AND state='live' AND revoke_version=? AND expires_at>? AND used_bytes+?<=max_bytes AND submission_count<?").bind(total, session.id, session.revoke_version, now(), total, Number(env.MAX_SUBMISSIONS_PER_SESSION)).run(); if (!reservation.meta.changes) { await env.DB.prepare(`UPDATE capabilities SET upload_state='uploaded' WHERE id IN (${ids.map(() => "?").join(",")}) AND upload_state='finalizing'`).bind(...ids).run(); const refreshed = await env.DB.prepare("SELECT state,revoke_version,expires_at,used_bytes,max_bytes,submission_count FROM sessions WHERE id=?").bind(session.id).first<Session>(); if (refreshed?.state === "live" && refreshed.revoke_version === session.revoke_version && refreshed.expires_at > now() && (refreshed.used_bytes >= refreshed.max_bytes || refreshed.submission_count >= Number(env.MAX_SUBMISSIONS_PER_SESSION))) return withGuestCORS(capacityExhausted(), request, env); return ended(); }
    const submissionID = id(); const receipt = guestReceipt(); const audio = objects.find(item => item.cap.media_kind === "audio")!; const photos = objects.filter(item => item.cap.media_kind === "photo"); const audioKey = `pending/${session.id}/${submissionID}/${audio.cap.id}`; const photoManifest = photos.map(item => ({ key: `pending/${session.id}/${submissionID}/${item.cap.id}`, bytes: item.object!.size, sha256: item.object!.customMetadata?.sha256 || "" }));
    try {
      // 先复制全部对象，所有对象完成后才把 submission 公开为 ready，Host 不会看到半成品。
      await Promise.all(objects.map(async item => { const source = `quarantine/${session.id}/${item.cap.id}`; const staged = await env.MEDIA.get(source); if (!staged) throw new Error("quarantine_object_missing"); const destination = `pending/${session.id}/${submissionID}/${item.cap.id}`; await env.MEDIA.put(destination, staged.body, { httpMetadata: staged.httpMetadata, customMetadata: staged.customMetadata }); await env.MEDIA.delete(source); }));
      const submittedAt = now();
      await env.DB.batch([env.DB.prepare("INSERT INTO submissions(id,session_id,state,audio_key,audio_bytes,audio_sha256,photo_manifest,guest_receipt,created_at,finalized_at,expires_at) VALUES(?,?, 'ready',?,?,?,?,?,?,?,?,?)").bind(submissionID, session.id, audioKey, audio.object!.size, audio.object!.customMetadata?.sha256 || "", JSON.stringify(photoManifest), receipt, submittedAt, submittedAt, submittedAt + 86_400), env.DB.prepare(`UPDATE capabilities SET upload_state='finalized' WHERE id IN (${ids.map(() => "?").join(",")}) AND upload_state='finalizing'`).bind(...ids)]);
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
    const { data, hostID } = await hostBody(request, env); if (!hostID || data.byteLength) return json({ code: "unauthorized" }, 401); const retryAfter = await consumeHostRateLimit(env, hostID, limits.hostSensitive); if (retryAfter !== null) return tooManyRequests(retryAfter); const session = await env.DB.prepare("SELECT id FROM sessions WHERE id=? AND host_id=?").bind(parts[3], hostID).first(); if (!session) return ended(); const result = await env.DB.prepare("SELECT id,audio_bytes,audio_sha256,photo_manifest,created_at FROM submissions WHERE session_id=? AND state='ready' AND expires_at>? ORDER BY created_at LIMIT 20").bind(parts[3], now()).all<Pick<Submission, "id" | "audio_bytes" | "audio_sha256" | "photo_manifest" | "created_at">>(); return json({ submissions: result.results.map(publicSubmission) });
  }
  if (parts[0] === "v1" && parts[1] === "host" && parts[2] === "submissions" && parts[4] === "media" && request.method === "GET") {
    const { data, hostID } = await hostBody(request, env); if (!hostID || data.byteLength) return json({ code: "unauthorized" }, 401); const retryAfter = await consumeHostRateLimit(env, hostID, limits.hostSensitive); if (retryAfter !== null) return tooManyRequests(retryAfter); const submission = await env.DB.prepare("SELECT sub.*,s.host_id FROM submissions sub JOIN sessions s ON s.id=sub.session_id WHERE sub.id=?").bind(parts[3]).first<Submission>(); if (!submission || submission.host_id !== hostID || submission.state !== "ready") return ended(); if (submission.expires_at <= now()) return submissionExpired(); const photoIndex = url.searchParams.get("photoIndex"); const photos = parsePhotos(submission.photo_manifest); const requestedKey = photoIndex === null ? submission.audio_key : (/^(0|[1-5])$/.test(photoIndex) ? photos[Number(photoIndex)]?.key : undefined); if (!requestedKey) return ended(); const object = await env.MEDIA.get(requestedKey); if (!object) return ended(); return new Response(object.body, { headers: securityHeaders({ "content-type": object.httpMetadata?.contentType || "application/octet-stream", "content-length": String(object.size), "cache-control": "no-store" }) });
  }
  if (parts[0] === "v1" && parts[1] === "host" && parts[2] === "submissions" && parts[4] === "ack" && request.method === "POST") {
    const { data, hostID } = await hostBody(request, env); if (!hostID || data.byteLength) return json({ code: "unauthorized" }, 401); const retryAfter = await consumeHostRateLimit(env, hostID, limits.hostSensitive); if (retryAfter !== null) return tooManyRequests(retryAfter); const submission = await env.DB.prepare("SELECT sub.*,s.host_id FROM submissions sub JOIN sessions s ON s.id=sub.session_id WHERE sub.id=?").bind(parts[3]).first<Submission>(); if (!submission || submission.host_id !== hostID) return ended(); if (submission.state === "acked") return json({ acknowledged: true }); if (submission.state !== "ready") return json({ code: "invalid_state" }, 409); if (submission.expires_at <= now()) return submissionExpired(); const changed = await env.DB.prepare("UPDATE submissions SET state='acked',acked_at=? WHERE id=? AND state='ready' AND expires_at>?").bind(now(), submission.id, now()).run(); if (!changed.meta.changes) return submissionExpired(); await env.MEDIA.delete([submission.audio_key, ...parsePhotos(submission.photo_manifest).map(photo => photo.key)]); return json({ acknowledged: true });
  }
  return json({ code: "not_found" }, 404);
}, async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
  // 每五分钟扫描一次；直接访问同样按 expires_at 拒绝，保证超过 24 小时不能再下载。
  const purged = await purgeExpiredUnacknowledgedMedia(env);
  console.log("web_guest_expired_media_purged", { purged });
} };
