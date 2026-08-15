# AI 交接记录

## 2026-08-15：Web Guest 生产 Cloudflare 与官网同步发布

- 按产品所有者授权，已恢复 **单一生产环境**：Worker `event-voice-booth-web-guest`、Pages `event-voice-booth-guest` 和私有 R2 `event-voice-booth-guest-media`。没有创建测试环境、测试账号、调试 API、公开 R2 域名或 Preview Worker URL；Worker 明确 `preview_urls = false`，唯一写路径继续是有 App Attest、StoreKit JWS、Host 私钥签名、一次性 assertion、对象授权与限流保护的生产 Host API。
- 生产 D1 使用独立空库 `event-voice-booth-guest-prod`（ID `97876567-34bd-4106-b221-61d4e57fb9e2`），未复用已下架运行时的审计库。新增 `0001_initial_schema.sql` 与历史 `0002`–`0009` 严格串行，已从空库完成全量迁移并核验 `submission.expires_at`、`hosts.subscription_expires_at`、`hosts.last_assertion_failure` 及全部 9 条 migration history；后续不得直接执行 schema.sql 代替迁移。
- R2 未开启公开访问，只绑定 Worker；所有对象在 1 天后过期，未完成 multipart 1 天中止。Worker secret 仅有部署控制台保存的 `IP_HASH_SALT`，未写入仓库、D1、日志或变量；生产 cron 每 5 分钟清理过期的 ready/未 finalize 媒体。Worker 当前版本 `f7f93129-3f00-4a95-9e8b-c9155127c4d1`，Pages Production deployment `0f12f91a-9cfb-4f2f-a5f6-a775b84d4e82`，地址分别为 `https://event-voice-booth-web-guest.event-voice-booth-web-guest.workers.dev` 和 `https://event-voice-booth-guest.pages.dev`。
- 匿名 HTTPS 验证：Pages 根页为 200 且带 CSP、`no-store`、防嵌入和最小权限策略；Worker 无效 Guest access 为 410；Pages `/join/not-a-valid-slug` 同样为 410，证明公开静态重写不会绕过 revoke/access gate。官网首页、隐私页、支持页的文案已同步 Web Guest 临时私有存储、24 小时删除、Host stop 撤销、浏览器本机自拍效果及 US$9.99/月 Host Monthly；公开 GitHub Pages 尚待本分支经 PR 合并 `main` 后发布。
- 验证：`npx tsc --noEmit`、`npx wrangler check startup`、`node --check public/join.js`、`node --check 'functions/join/[[slug]].js'`、`npx wrangler d1 migrations apply event-voice-booth-guest-prod --remote`、D1 Schema/migration 查询、`npx wrangler deploy`、`npx wrangler pages deploy public --project-name event-voice-booth-guest --branch main`、R2 lifecycle 查询与匿名 `curl` 均通过。尚未覆盖：真实 App Attest + StoreKit 生产 JWS 注册、真机 Safari 自拍/上传、Host 原子导入/ACK、Stop revoke 与 24 小时 cron 删除竞争；这些是上线后首轮真机验收，不能由匿名 API 检查替代。

## 2026-08-15：Host Monthly 与 Web Guest 自拍效果（未部署）

- 网站首页、隐私页和支持页本地文案已随 iOS 改为新购 `US$9.99/月` 自动续期 Host Monthly；旧 `com.eventvoicebooth.host.lifetime` 买家永久保留权益。站点、Pages、Worker 和迁移均未部署，不能作为公开已生效事实。
- Web Guest 现以 `capture="user"` 优先前置自拍；拍后在浏览器本机通过随 Pages 打包的 MediaPipe Face Landmarker/WASM 与 Canvas 提供 `Natural`、Big Head、Party Wig、Bunny Ears、Goofy Glasses、Alien Eyes、Paper Bag、Face Warp、Big Eyes、Fake Mustache、Sunglasses 十一项效果。仅对“Take a selfie”入口应用效果；相册选择保持原图 Canvas 压缩，避免擅自处理非自拍照片。图片帧、landmarks、WASM 结果和原图不写 localStorage/IndexedDB、不发送第三方；只有去 EXIF 的最终 JPEG 受既有 capability 上传，仍受每张 768 KiB 服务端限制。人脸未识别、WASM 失败或 12 秒超时时回退原自拍，不阻断留言。
- `web-guest/functions/join/[[slug]].js` 在 Pages 边缘请求最小化 Worker `access` 会话检查后才返回 HTML；`/join/*` 静态 rewrite 已移除。Host stop/revoke 后，重新打开二维码会被边缘函数返回无状态 `410`，不再展示录音页面；已打开页面的 capability/finalize 服务端检查继续拒绝新投稿。必须把该 Pages Function 与 Worker 同次部署，并用真实 revoke 后的匿名 HTTPS 请求验证页面和 API 都是 410。
- 新增 MediaPipe 依赖及本地发布文件：`@mediapipe/tasks-vision@0.10.22-rc.20250304`、`public/vendor/mediapipe/{vision_bundle.mjs,vision_wasm*,face_landmarker.task}`。当前静态资源约 23 MiB；因当前 Web Guest 运行环境已下架，部署前必须评估 Pages 冷启动/移动网络下载、iPhone Safari 内存和温升。CSP 仍限制脚本、模型和 WASM 为同源，不使用 CDN。
- 验证：`node --check public/join.js`、`node --check 'functions/join/[[slug]].js'`、`npx tsc --noEmit`、`npx wrangler check startup`、`git diff --check` 均通过。Worker startup 本地 bundle 为 1287.46 KiB（gzip 208.83 KiB），启动采样 49.3 ms；不代表 Cloudflare 实际性能。未完成 iPhone Safari 自拍、方向/镜像、横竖屏、11 种效果、人脸失败回退、标签无障碍、Pages Function 410、Host revoke、上传/ACK/24 小时清理、App Attest/StoreKit JWS 的重新部署端到端验收。

## 2026-08-14：Guest 过期提示与未 ACK 媒体 24 小时清理（未部署）

- Guest bootstrap、capability 和 finalize 在 QR Session 到期时现在返回明确的 `410 session_expired`：链接已到期，Host 不再接收新留言；撤销或未知链接仍保持通用 `410`，不泄露活动是否存在。网页直接展示服务端安全消息，不会把过期误报为麦克风或浏览器失败。
- `submissions.expires_at` 固定为 finalize 后 24 小时。Host 列表过滤已过期投稿，媒体下载与 ACK 再做时间条件检查；即使 cron 尚未执行，也无法在 24 小时后继续导入媒体。`0008_submission_expiry.sql` 为历史记录回填该期限。
- Worker 增加每 5 分钟 cron：将过期 `ready` 投稿原子标记为 `discarded` 后删除私有 R2 音频和照片；也清理超过 24 小时、未 finalize 的 quarantine 上传。ACK 仍在本机原子保存成功后立即删除媒体。Session 到期不会被 cron 写成 `expired`，以便 Host 随后仍可完成已签名 revoke 并留下可验证关闭记录；Guest 写入始终同时受 `state` 与 `expires_at` 限制。这个清理只能在未来新建并部署 Worker/R2、执行同源迁移后生效；本轮未重新部署已下架运行时。
- 验证：在 `web-guest/` 执行 `npx tsc --noEmit`、`npx wrangler check startup`、`node --check public/join.js` 与 `git diff --check`，均通过。未覆盖：尚无 Worker D1/R2 集成测试；重新上线前必须在隔离运行时验证 cron、到期边界、Host 下载/ACK 竞争与 R2 删除审计。

## 2026-08-14：无账号可信 Host API 防滥用补强（未部署）

- Web Guest 后端继续采用无账号的设备绑定 Host 身份：注册验证 App Attest、ThisDeviceOnly P-256 Host 公钥和 Apple 已签名 StoreKit Host Lifetime 交易；后续请求的 canonical `method/path/timestamp/nonce/body SHA-256` 签名、一次性 assertion challenge、App Attest signCount CAS 与对象归属检查均由 Worker 强制执行。
- 新增 Host ID 维度限流：敏感操作每 Host 每小时 120 次、assertion challenge 每 Host 每小时 180 次，补足 App Attest 无法阻止真实设备自动化调用的边界。Session 创建的畸形 JSON 或非法 `maxBytes` 改为明确 `400 invalid_request`，不再冒泡为 500。
- Guest capability、Session/revoke version 绑定、HMAC IP 限速、上传租约、媒体实际格式/大小校验、配额、原子 ready、Host-only 下载、落盘后 ACK 与 revoke 语义未被放宽。没有账号、没有匿名 Host 注册、没有公开 R2 URL。
- 验证：`npx tsc --noEmit`、`npx wrangler check startup`、`node --check public/join.js`、`git diff --check` 通过。`npm test` 返回无测试文件；必须在重新部署前补充 Worker 的 D1/R2 路由测试，覆盖 Host 对象越权、nonce/assertion/capability 重放、限流、Stop 与 finalize 并发、ACK 删除。
- 本次没有创建/部署 Worker、Pages 或 R2，未改变运行时下架决定，也未更新公开隐私、网站或 App Store 事实。重新开放仍须新建隔离运行时、执行迁移与 drift 校验、真机端到端演练和隐私/审核门禁。

## 2026-08-13：Web Guest Cloudflare 运行时已下架（暂不发布）

- 产品所有者决定本版本暂不发布 Web Guest。已不可逆删除 Cloudflare Worker `event-voice-booth-web-guest`、Pages 项目 `event-voice-booth-guest` 与私有 R2 bucket `event-voice-booth-guest-media`；本地 `web-guest/` 源码保留，便于未来在重新评审后从零部署，不代表功能可用。
- 下架前后远端 D1 核验所有 3 条投稿均为 `acked`，没有 `ready` 或待导入媒体，因此删除 R2 未丢弃待处理用户内容。D1 `event-voice-booth-guest`（ID `0f160988-bd23-4c74-b453-be1e67d54095`）仅作为非公网审计记录保留；它没有公开 HTTP 入口，也不再被 Worker 绑定。
- 外网暴露面复核：Worker `https://event-voice-booth-web-guest.event-voice-booth-web-guest.workers.dev` 返回 HTTP 404；Pages 域名 `event-voice-booth-guest.pages.dev` 已无法 DNS 解析；`wrangler pages project list` 与 `wrangler r2 bucket list` 均不再列出相应资源。不得重新部署或恢复 Host 注册开关，除非产品所有者重新授权并完成新的安全/发布验收。
- 本次不上传新构建、不更新 App Store Connect、不提交审核。现有含 Web Guest UI 的诊断/TestFlight 构建不应作为生产发布候选，因为其服务端已被撤销，会安全失败。
- 验证：`npx wrangler delete event-voice-booth-web-guest`、`npx wrangler pages project delete event-voice-booth-guest --yes`、`npx wrangler r2 bucket delete event-voice-booth-guest-media`、远端 D1 投稿状态查询、匿名 `curl` Worker/Pages、`wrangler pages project list`、`wrangler r2 bucket list`。残余风险：D1 仍保存最小审计元数据；若未来决定彻底删除该数据，须先由产品所有者确认数据保留期与不可恢复删除范围。

## 2026-08-13：Web Guest 照片 Safari 解码与发送竞态修复

- 真机反馈网页投稿后 Host 没有图片。远端 D1 核验显示该次及此前投稿的 `photo_manifest` 都是空数组，说明图片没有进入私有 R2/提交清单；不是 Host 下载或 ACK 删除遗漏。网页原来使用 `createImageBitmap` 压缩相册图片，此 API 在 iOS Safari（特别是 HEIC 相册资源）并不稳定，失败后会按安全策略清空本次照片选择。
- `web-guest/public/join.js` 现改为只在内存中使用 `Image` 对象 URL + Canvas 解码并压缩为 JPEG；完成或失败都立即释放对象 URL。选择图片期间禁用 Send，准备完成后明确显示本次将提交的图片数量，避免异步压缩尚未结束就 finalize 纯音频。保持单张 768 KiB、最多 6 张、无原图/EXIF 上传、私有 R2 与原有 capability 验证不变。Pages Production 最新部署 `b566879e-6989-42f6-b3a6-b4e707293ad5`。
- 同一时刻远端存在一条 `ready` 留言，且 Host 的 App Attest signCount 已成功递增、无 assertion failure；若 App 仍显示 `No verified Web Guest messages are waiting.`，需继续在 iOS 侧检查该请求所使用的本地 `webGuestSessionID` 与 Worker 返回/解码日志，不能以该文案推断上传丢失。
- 验证：`node --check public/join.js`、`npx tsc --noEmit`、`npx wrangler check startup`、`git diff --check`、Production Pages HTTPS 深链与资源读取。未覆盖：尚需用户在真机 Safari 重新选择至少一张照片、完成投稿，再在同一 Live Event Host 导入并确认照片显示；D1 migration history 既有漂移风险不变。

## 2026-08-13：照片入口歧义与永久 Preparing 状态修复

- 原单一 file input 使用 `capture=environment`，在 iPhone 上容易表现为只能拍照，且“Optional photos”文案无法说明相册选择能力。现在拆为明确的 `Take a photo`（仅相机）和 `Choose photos`（相册、多选）两项；仅接收 JPEG/PNG，避免 iOS HEIC 解码长期挂起或未验证格式。
- 图片 `Image` 解码与每轮 Canvas JPEG 编码均加 15 秒超时。超时或失败会清空本次图片、恢复两个入口和 Send，并显示可恢复的 JPEG/PNG 提示，避免永久 `Preparing photos securely…`。图片仍仅在页面内存和短期私有 R2 链路内处理，不写入浏览器持久化存储。
- 已部署 Pages Production `cdf8dd6b`。验证：`node --check public/join.js`、`git diff --check`、canonical Pages HTML/JS 匿名检查确认两个入口与超时逻辑存在。未覆盖：需要真机 Safari 选择相册 JPEG/PNG 与拍照 JPEG 各一次，完成 upload → Host import/ACK 验收。

## 2026-08-13：Safari 异步照片选择状态复位补丁

- 真机仍出现永久 `Preparing photos securely…`。根因是图片处理 `await` 之后继续读取 `event.currentTarget`；Safari 可在异步边界清空该事件字段，导致 `finally` 自身抛错，状态与按钮无法复位。现在在 handler 同步开始时固定 `input` 引用，后续读取文件数量和清空 value 都只使用该稳定引用。
- 该修复保证成功、解码失败、编码超时三种路径均会执行 `photosPreparing=false`、恢复 Take/Choose 与 Send。已部署 Pages Production `ab47f3c6`；匿名读取 canonical `/join.js` 已确认稳定 input 路径。
- 验证：`node --check public/join.js`、`git diff --check`、Production Pages deploy/curl。仍需真实 Safari 选择一张 JPEG/PNG 核验图片数量出现后再提交。

## 2026-08-13：Web Guest 生产 Pages 深链与 Safari 上传兼容性修复

- 用户扫码曾见 Cloudflare 默认 `Nothing is here yet`。根因是访客静态页面只部署到 Preview 分支，二维码使用的 canonical production URL `https://event-voice-booth-guest.pages.dev/join/<slug>` 尚无生产部署。已将 `web-guest/public` 部署为 Pages `main` / Production（deployment `84b2b0a8-e384-496d-b900-ef698acf8cf3`），并匿名验证真实 live slug 返回 200 与 `Leave a voice message`，不再返回默认空页。
- 访客页 CSP 的 `connect-src` 仅增加精确 Worker Origin `https://event-voice-booth-web-guest.event-voice-booth-web-guest.workers.dev`；没有放宽通配域名、嵌入或媒体来源。Worker 的精确 Pages Origin CORS bootstrap 也已验证返回 200。
- Safari 浏览器不允许网页脚本设置受限请求头 `Content-Length`。已移除该客户端头；Worker 版本 `7c3f7aa3-cb44-4a5a-a5d1-45565f3b1b9e` 仍严格按实际 body byteLength、可选平台长度头与 capability 上限验证，并保持 5 MiB 音频、768 KiB 照片、限流/租约/私有 R2 不变。修复期间一处正则转义导致正常长度被误判 `invalid_size`，已立即更正并重新部署该版本。
- 验证：`npx tsc --noEmit`、`npx wrangler check startup`、`node --check public/join.js`、`git diff --check`、`curl -I` canonical Pages join route、真实 slug HTML 内容和带精确 Origin 的 Worker bootstrap 均成功。未覆盖风险：仍需在真机 Safari 完成录音/照片 → upload → finalize → iOS 原子导入/ACK → Stop Event revoke 的完整人工验收；D1 migration history 既有漂移，直接执行全量 `wrangler d1 migrations apply` 会撞到已有字段，后续需先安全对齐 migration history。

## 2026-08-13：Web Guest 手机浏览器自适应修复

- 访客页改为 mobile-first：viewport 使用 `viewport-fit=cover`，正文适配 iOS 安全区和动态视口高度（`100dvh`），小屏从顶部自然排版，移除横向溢出；输入、音频预览与内容卡片限制在可用宽度内。520px 以下将录音操作由两列折叠为单列，标题、边距和卡片内边距同步收紧。
- 深链实际服务入口为 `public/index.html`，并非冗余 `public/join/index.html`；已把 viewport 修复写入真实入口，并把 `_redirects` 明确改为 `/join/* → /index.html 200`，避免两份页面以后漂移。Production Pages 最新部署为 `746fa20d`，canonical join URL 已匿名复核包含 viewport-fit 与移动端 CSS。
- 验证：`node --check public/join.js`、`git diff --check`、正式 Pages 部署以及 canonical HTTPS 真实 slug 返回检查通过。未覆盖风险：尚未在实机 Safari 的横竖屏、较大字体和键盘弹出状态完成视觉人工验收。

## 2026-08-13：Host assertion 防重放与网页回执边界修复

- Worker 已部署 `7939f013-6f78-41bb-9a21-460ea2af3ef8`；远端 D1 已执行 `web-guest/migrations/0006_host_assertion_binding.sql`。每个 Host 敏感请求必须先由 P-256 签名领取与该条 canonical request digest 绑定的短期 App Attest challenge；Worker 校验 assertion 后以单次 challenge 消费和 host signCount CAS 防止重放/并发竞争。Host 注册开关仍为 `HOST_REGISTRATION_ENABLED=false`，不可因本次部署开放。
- Guest bootstrap 已返回精确 Pages Origin CORS；receipt 查询改为 `/v1/guest/<slug>/receipts/<receipt>`，同时校验 QR slug、256-bit receipt 与 Pages Origin，避免高熵 receipt 单独成为跨 Session 查询句柄。
- 验证：`npx tsc --noEmit`、`npx wrangler check startup`、`node --check public/join.js`、`git diff --check`、远端 D1 执行和 `npx wrangler deploy` 成功。真实 App Attest/生产 StoreKit 交易、iOS Host 注册/QR/导入/ACK/revoke 全链路仍需在物理设备演练；演练前严禁打开注册开关，也不得同步公共隐私或商店事实。

## 2026-08-13：Web Guest 防盗刷加固与真实 Apple 验证代码（未开放）

- Worker 已部署 `c14b2fe1-d2d1-4968-904d-94aae4408a99`，但 `HOST_REGISTRATION_ENABLED=false`。所有 Host 注册与 challenge 都 fail-closed；不得改为 true，直到 iOS Host 完整接入、真机 App Attest/生产 StoreKit JWS 端到端验证和发布门禁完成。
- 本轮加固：真实 App Attest 与 StoreKit JWS 服务端验证代码、单次 challenge、私有 R2、精确 Origin CORS、HMAC IP/Session/capability 限速、上传租约与原子状态、100 条/250 MiB/20 live 服务器硬帽、全量复制后才 ready、无 R2 key manifest、256-bit Guest receipt ACK 查询和 ACK 删除。网页已实现同意、Safari MP4/AAC 录音和 JPEG 无 EXIF 压缩；WebM/Android 明确不上传。
- 远端 D1 的 submission integrity 与 Host authentication schema 已执行并核验；R2 仍 0 object/0 B，`quarantine/` 和 `pending/` 1 天自动删除。验证：`npx tsc --noEmit`、`npx wrangler check startup`、`npx wrangler deploy`、`node --check public/join.js`、`git diff --check`。
- 发布仍阻断：iOS Host 暂未调用 Worker/显示 QR/下载导入/ACK，停止 Event 也暂未先远端撤销。因此网页不可作为公开功能、官网/隐私/App Store 当前“没有开发者服务器/云端上传”的事实不得修改为已上线。

## 2026-08-13 — Web Guest 免费层安全工程初始化（未部署、未可用）

- 新增 `web-guest/` 作为未来 Guest runtime 的独立工程；它不会替代现有 marketing/privacy/support 静态页。工程声明私有 R2、D1、Worker 与独立 Pages 项目，实施不透明短期 QR、Host 请求签名/replay nonce、严格 CSP/Origin、短期上传 capability、对象私有键、大小与媒体魔数校验、Event 配额、Host-only 领取和 ACK 后删除的基础契约。
- Wrangler 免费层已创建 D1 `event-voice-booth-guest`（ID `0f160988-bd23-4c74-b453-be1e67d54095`）、Pages 项目 `event-voice-booth-guest`（预览 `https://c90dc99a.event-voice-booth-guest.pages.dev`）和私有 R2 `event-voice-booth-guest-media`。R2 未配置公开访问，初始为空；`quarantine/`、`pending/` 均有 1 天删除生命周期，默认不完整 multipart 在 7 天清理。Worker `event-voice-booth-web-guest` 已部署并绑定 D1/R2，版本 `e645e20d-204e-42ba-9151-68278cd9f35b`；仍无完成的网页投稿功能。
- 该项目的旧“不得宣称”规则已改为发布门禁：完成 R2、Worker/Pages、安全验收、App 真实接入、隐私与商店事实更新前，不能对外声称 Web Guest/云端媒体/免安装投稿。不得以当前工程的存在发布或宣传功能。

### 2026-08-13 — Worker 代码级限速

- 已部署 Worker `9b995ff0-2cd6-4d4a-a694-5575ed2ae090` 增加 D1 固定窗口限速和上传并发租约：IP 仅以 `IP_HASH_SALT` HMAC 摘要参与键值，原始 IP 不持久化；bootstrap 30/IP/min，capability 12/IP/min + 100/Session/hour，upload 12/IP/min + 120/Session/hour + 1/capability/10min，finalize 8/IP/min + 100/Session/hour。超限返回 429 和 Retry-After。
- `upload_leases` 将并发上传限制为每 Session 4、每 IP 摘要 2，120 秒租约到期自动释放；断连不会永久消耗名额。缺少 secret 或边缘未提供 IP 时公开写路径 503 fail-closed。D1 迁移 `web-guest/migrations/0002_request_rate_limits.sql` 已远端执行并核验两个新表。

### 2026-08-13 — Web Guest 上传完整性与公开面收紧

- Host 注册仍由 `HOST_REGISTRATION_ENABLED=false` 默认硬关闭；在 Worker **实际**完成 App Attest assertion 与 App Store 服务端交易验证前，任何公钥注册请求均返回 503，禁止把本机购买状态当作服务端授权。
- Worker `aad94ef7-e90f-4b44-a9e4-b2799148c6cc` 已部署 migration `web-guest/migrations/0004_submission_integrity.sql`：上传 capability 使用 `issued → uploading → uploaded → finalizing → finalized` 原子状态迁移，同一 token 的并发 PUT 或 finalize 只能成功一次；失败会删除 quarantine/pending 对象、归还 Event 字节/条数预留并恢复可重试状态。
- finalize 先完整复制私有 R2 对象，随后才将 submission 标记 `ready`，避免 Host 读取半成品；提交清单不再泄露 R2 object key。Host 仅可按受控 API 下载音频或索引照片；Guest 仅用 256-bit receipt 轮询 `pending_host`/`saved_by_host`，无媒体或活动信息泄露。
- Browser API/预检现仅接受精确生产 Pages Origin，并返回精确 `Access-Control-Allow-Origin`（无 `*`）；Worker 内部 API 不依赖 CORS。Host nonce 改为 SQLite `INSERT OR IGNORE` 原子占用，防止并发重放。
- 验证：`npx tsc --noEmit`、远端 D1 迁移执行及 `PRAGMA table_info(capabilities)`、receipt 索引查询、`npx wrangler deploy` 均成功。迁移/Worker 未包含真实 App Attest 或 App Store 交易密钥；因此注册仍 fail-closed，网页 Guest 功能不能对外宣称已可用。

### 2026-08-13 — 免费层容量硬帽

- 在不改变 Host Lifetime 一次购买的前提下，每场上限调整为 100 条网页留言与 250 MiB 临时媒体；Worker 仍强制限制 20 场同时 live Web Session、每条音频 5 MiB、每张照片 768 KiB（最多 6 张）。第 21 场返回 503 + Retry-After；第 101 条或超容量返回 429 + Retry-After。以 2–3 分钟、96 kbps 音频和 0–2 张压缩照片的常见组合估计，100 条通常约 150–250 MiB；总量硬帽保护照片更多或音频更长的峰值。
- D1 migration `0003_free_tier_hard_caps.sql` 已远端执行，`sessions.submission_count` 已核验。该限制配合 ACK 即删及 1 天 R2 TTL，防止免费额度被无限临时媒体占用；不构成对免费层永久可用性的保证。

## 2026-08-10 — 1.1.4 Memory Movie 与官网 SEO

- 分支 `feature/refresh-1.1.4-memory-movie` 同步 App 1.1.4 已实现的本地 Memory Movie：固定 16:9、1080p，按留言从旧到新，使用各留言自己的照片，无照片时使用 Event 主题；不声称自动配乐、AI 剪辑或视频投稿。
- 首页 title/description 收敛为 wedding audio guestbook + Memory Movie；隐私页说明本机生成、系统分享和临时文件清理；支持页补充入口、前台/存储排障与源留言不变。
- 未新增脚本、第三方依赖、追踪或视觉 token；继续使用既有三页布局与响应式规则。公开联系邮箱保持 `dylan120liu@gmail.com`，版权保持 `© 2026 Dylan Liu`。
- 发布前必须运行本地链接/事实/敏感信息检查，经独立 PR 合并到 `main`，等待 Pages 部署后匿名复核 `/`、`/privacy/`、`/support/` 三页 HTTPS 200，再把 commit、PR、workflow 与公开 URL 写回 App 和 Site 交接记录。
- 已完成：提交 `80a132c5a884d3252fa2271f68347c4af9d7fe61` 经 [PR #5](https://github.com/dylan120/event-voice-booth-site/pull/5) 合并，merge SHA `1c76533b9725fe6bc75e07d7a604c92906da5e59`；Pages run `31369684601` 成功。2026-08-10 16:22 +0800 匿名复核首页、隐私页和支持页均 HTTPS 200，Memory Movie、联系邮箱及版权已持久化。Pages 为 legacy `main` `/` source；构建仅有 Node.js 20 迁移到 24 的平台弃用警告。

## 2026-08-08 — Guest content authorization for 1.1.3 build 20

- 隐私页现明确：Guest 在新留言保存或发送前确认有权分享录音与照片，并授权 Host 在该 Event 内保存、播放、展示、导出以及向附近 Voice Booth 用户分享；App 随留言保存授权版本、接受时间与完整文案。
- 旧留言仍可由 Host 本地播放/导出，但没有当前授权证据时不进入 Nearby Live View 或 ended Event copy；恢复的未发送草稿必须重新确认授权。
- 支持页同步新的 Guest 操作要求。公开联系邮箱继续为 `dylan120liu@gmail.com`，三页版权继续为 `© 2026 Dylan Liu`。

## 2026-08-08 — 1.1.3 Nearby Event Share

- 官网、隐私页和支持页同步 1.1.3：Host Lifetime 可创建 Live Event 只读查看邀请，或把 ended Event 作为独立本地副本传给附近已安装 App 的用户；接收免费，不使用开发者服务器。
- 隐私政策生效日期更新为 2026-08-08，明确两种 Event Share 均通过加密 Multipeer Connectivity 在附近设备间传输；不新增账号、分析、广告、跟踪或云端媒体存储。
- 待通过独立 Site 仓库 GitHub Flow 合并并重新验证 Pages 三个 canonical URL 后，才能把新文案视为已公开发布。

## 2026-08-06 — 1.1.2 产品事实同步

- 在独立分支 `feature/refresh-1.1.2-site` 同步 App 1.1.2：每条语音最多包含 6 张可选照片；首页补充 wedding audio guestbook 定位与全屏 Memory Show，隐私页和支持页同步更新数量及权限说明。
- 联系邮箱仍为 `dylan120liu@gmail.com`，三页版权仍为 `© 2026 Dylan Liu`；不新增账号、开发者云媒体上传、网页投稿、Android 或免安装投稿声明。
- 已完成 `git diff --check`、三页产品事实/邮箱/版权核对及公开仓库敏感词扫描；未发现占位内容、凭据或待发布私密材料。系统 `tidy` 版本不识别 HTML5 的 `main`/`section`/`footer`，因此其 HTML4 兼容性报错不作为页面无效结论，仍需以 Pages 浏览器渲染和匿名 HTTPS 检查为最终验收。
- 远端已核对为公开仓库 `https://github.com/dylan120/event-voice-booth-site`，默认分支 `main`，当前 GitHub 身份为有权限的 `dylan120`。
- 发布前仍需完成 GitHub Flow PR/合并、Pages 部署与匿名 HTTPS 三页复核，并把最终 URL/commit/workflow 证据写回本文件及 App 交接记录。

## 2026-08-03 — 工作区目录迁移

- 正式项目路径为 `/Users/weijianliu/project/iosapp/sites/event-voice-booth-site`，Git 顶层目录已核对为该路径。
- 独立仓库基线为 `main` 分支 `b1da5ad9834bfbe283a931b641ed3a457cc5bd07`，迁移前与 `origin/main` 一致且工作树干净；目录迁移未执行检出、重置或代码覆盖。
- 本次仅修正迁移后的跨项目文档链接并补齐文档入口，不修改站点页面或产品事实。
- 验证命令：`git diff --check`、`git rev-parse --show-toplevel`、`git status --short --branch`。
- 未覆盖风险：本项目尚无确定性站点验证脚本；发布前仍需人工验证 `/`、`/privacy/`、`/support/` 的 HTTPS 匿名访问与页面内容。
- 旧工作区根仓历史的恢复入口由工作区治理记录统一维护；不得从旧根仓检出覆盖本独立仓库。
