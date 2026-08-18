# AI 交接记录

## 2026-08-18：Host 生命周期三条免费 Booth 留言

- Web Guest Worker 新增 D1 迁移 `0016_host_demo_quota.sql` 和 bearer-only Demo quota API。服务端只保存 Apple Sign in subject 的独立 HMAC 摘要、三条计数和录音 UUID 幂等 claim，不保存 subject、邮箱、姓名或 token；本地删除、换机、卸载重装及账号删除后重新登录均不能恢复额度。
- 已订阅 Host Monthly 由 Worker 的 `subscription_expires_at` 判断，不消耗试用；不能依赖客户端购买布尔值。`DEMO_QUOTA_SECRET` 已通过 Cloudflare secret 设置，未写入仓库；它必须独立于 `AUTH_TOKEN_SECRET`，避免认证密钥轮换重置配额。
- 生产前已导出 D1 到 `/private/tmp/event-voice-booth-demo-quota-backup/pre-0016.sql`（SHA-256 `12ffd5ace436a19198fcb4bcb490eaf46d6d401a1c86ee8897c74b391be4bc6c`），远端已应用/核验 0016 与两张表，Worker 已部署为 `22f579e2-ee0a-4a03-8169-62664923e75a`，`/health` 返回 200。验证：`npm test` 9/9、`npx tsc --noEmit`、`npx wrangler check startup`、dry-run、远端 schema 查询与 deploy。
- 未覆盖：以真机同一 Apple Host 试用三次、删除 Event 后第四次、重装后第四次、双设备并发和订阅 Host 的端到端验证；回滚只能回退 Worker，不能删除 0016 表或账本，否则会重新开放已消耗额度。

## 2026-08-15：Web Guest 上传期间使用强提醒弹窗

- Guest 点击 `Send to host` 后，页面改为展示居中、不可手动关闭的上传中模态弹窗，明确要求在出现发送成功前保持浏览器页面打开；成功后弹窗确认上传完成，失败时弹窗保留可恢复说明并允许关闭后重试。
- 上传和 finalize 未完成期间注册 `beforeunload` 离页保护；浏览器支持时，返回、刷新或关闭页面会额外触发系统确认。Safari 是否实际展示系统确认由浏览器策略决定，因此不可替代页面内弹窗。
- 页面类型与基线仍为现有 Web Guest 单页 composer，复用既有背景、强调色、按钮、圆角、字体与响应式断点；没有新增样式 token、接口、D1/R2 Schema、媒体保留规则或上传契约。
- 验证：`node --check public/join.js`、定向静态交互断言、`git diff --check`。未覆盖：需在 iPhone Safari 真机验证上传中视觉、VoiceOver 焦点宣读、成功/失败恢复、返回手势及系统离页确认策略；本轮未部署 Pages，线上需完成同源部署后才生效。
- 已部署 Pages，部署预览为 `https://6fa4349d.event-voice-booth-guest.pages.dev`；生产 `join.js` 匿名获取后已核对包含上传中、成功、失败弹窗及 `beforeunload` 逻辑，`app.css` 返回 200 且继续使用 no-store/CSP 安全头。无效 Guest slug 按安全契约返回 410，因此未伪造有效 Session 做匿名页面冒烟；需使用 App 当前有效 QR 完成 Safari 真机投稿验收。

## 2026-08-15：新增 Host 账号删除后端契约

- 新增 bearer-only `DELETE /v1/auth/account`。若同一 Host 仍有 live Session 或 ready 投稿返回 409 且不删除任何账号数据；App 必须先完成 drain/ACK/revoke。通过门禁后先幂等删除 R2 pending/quarantine对象，再按依赖顺序删除D1关联元数据和Host/Apple subject。
- 官网 Privacy 与 Support 已同步提供 App 内账号删除入口、服务端删除范围及“设备内已保存媒体不会被远程删除”的边界，避免审核信息与实现漂移。
- 删除安全门禁增加 `hosts.deleting_at`（迁移 `0015_host_account_deletion_lock.sql`）：账号删除和 Guest finalize 通过 D1 条件更新互斥，同时阻断 live、ready、uploading/uploaded/finalizing 状态；Bearer header 严格限制 `HS256/EVB`。新增 4 个 Worker 回归覆盖无 bearer、未收尾 409、目标 Host 边界和拒绝带 body。
- 发布前 D1 已导出到 `/private/tmp/event-voice-booth-pre-account-delete-20260815.sql`（SHA-256 `0ecc10b7e202820df9c2c0dd75b9e5916ca7f6ab53aff685b768967f49a184de`），随后应用并核验迁移 0014/0015 和字段；生产 Worker 版本为 `ae075ea8-db77-44cb-9de0-0949dde5e903`，health 200、无 bearer 删除 401。未执行真实账号删除；跨 R2/D1 不具全局事务，R2 成功/D1 失败仍需依靠幂等重试和运维观察前向修复。
- R2失败发生在D1删除前，可安全重试；无Schema或迁移变更。接口不接受body，不允许App Attest/P-256回退，不影响本地Event或录音。

## 2026-08-15：提供旧 Session 已结束的对象级恢复证明

- `/v1/host/sessions` 新增可选 `previousSessionID` 请求字段与 `previousSessionEnded` 响应字段，用于 App 在登出/重登或本地落盘中断后安全恢复后端唯一 live Session。只有 bearer 所属同一 Host 的旧 Session 状态为 revoked/expired 才返回 true；未知、其它 Host 或仍 live 均返回 false，避免对象探测与越权接管。
- 这是向后兼容的可选契约扩展；无 D1 Schema、迁移、R2 或 Guest URL 变更。旧客户端不携带字段时仍获得原 Session 响应并忽略新增字段。

## 2026-08-15：为 End Event 401 增加脱敏阶段诊断

- Worker 的 bearer 校验新增固定失败类别，并在 `list/media/ack/revoke` 返回 `unauthorized_<stage>_<reason>`；日志只记录固定 stage/reason，不记录 bearer、Host ID、Apple subject、Session ID 或请求内容。认证、epoch、七天会话、refresh 重放与 Host 对象级授权判定均未改变。
- 无 D1 Schema、迁移、R2 对象或 URL 契约变更；现有 Session 与投稿无需迁移。部署前已执行 TypeScript、Worker startup、dry-run 与 diff 检查；仍需更新真机复现后按固定类别完成根因修复。

## 2026-08-15：Apple Host 身份与 bearer 认证主链收敛

- Host 认证已从“每次管理请求 App Attest assertion + P-256”迁移为 Sign in with Apple 单次 nonce、Apple RS256/JWKS 与精确 Bundle ID 验证、15 分钟 bearer、48 字节 refresh token 单次轮换和服务端七天绝对会话。D1 仅保存 Apple opaque `sub`、nonce/refresh 的 SHA-256 和必要的令牌 epoch；不保存 email、姓名、identity token、原 nonce 或 refresh 明文。StoreKit Host Monthly JWS 继续在创建 Session 前独立验签并绑定 original transaction。
- Worker `src/worker.ts` 已严格保持 bearer-only 的 Session/媒体管理路径。旧 App Attest/P-256 只允许在 `/v1/auth/apple` 完成未绑定历史 Host 的一次认领：请求必须携带匹配的 legacy Host ID，并由该 Host 的旧 P-256 私钥签署完整 Apple 登录 body；已移除“仅 Apple 身份与原交易即可恢复不存在 legacy Host”的降级例外。不能凭 QR、Event ID、交易历史或本机 UUID 接管旧 Host。
- Refresh 条件消费竞争也按重放处置：任一调用使用已撤销、已过期或失去 CAS 的 refresh token，都会提升该 Host `auth_epoch` 并撤销全部未撤销 refresh token，使所有旧 access token 立即失效。缺失/无效 bearer 管理接口返回 401；对象不属于当前 Host 的 list/download/ACK/revoke 统一返回 410。
- 已部署生产 Worker 版本 `0091bad9-a5b4-4f21-86b6-dde16f82a880`。本轮没有新增 Schema；远端 `wrangler d1 migrations list event-voice-booth-guest-prod --remote` 显示无待执行迁移。验证：`npx tsc --noEmit`、`npx wrangler check startup`、`npx wrangler deploy`、`curl /health` 为 200、无 bearer `POST /v1/host/sessions` 为 401、`git diff --check` 均通过。未记录/输出 `AUTH_TOKEN_SECRET`。
- 未覆盖：必须在隔离的 TestFlight/生产演练环境补 Host A/B bearer 越权、Apple nonce 双提交、refresh 双并发重放、旧设备 P-256 认领、Guest finalize 与 Stop/Replace drain → revoke → final drain 的集成测试；在这些证据完成前，不得声明现场生产安全验收或审核就绪。

## 2026-08-15：Guest Session 改为创建时验订阅的稳定短期租约

- 生产只读证据显示当前 Session 仍为 `live` 且 24 小时未到期，但 Sandbox `subscription_expires_at` 在创建约 35 分钟后结束；Guest access 每次同时检查订阅导致 Pages 提前 410，而 iOS 保存的 Session `expiresAt` 尚未到，因此不会换码。
- `liveSession` 现只检查 Session `state='live'` 与自身 `expires_at`。Host Monthly 仍在 `POST /v1/host/sessions` 创建时服务端验签，过期权益不能创建新 Session；已创建二维码作为最多 24 小时的短期租约，在自身到期或 Host revoke/stop 前稳定有效。Host bearer 对导入、ACK、revoke 的归属校验、未 ACK 媒体 24 小时删除、容量和限流均未放宽。
- 无 Schema/D1/R2/URL 迁移。TypeScript、Worker startup、deploy dry-run 与 `git diff --check` 通过；生产已部署 Worker `d11bfd28-062c-4335-aed2-cdf72acc2eff`。部署后当前真实 Session 保持 `live`，Worker access 返回 204、Pages join 返回 200、health 返回 200，无需换码即恢复；2 条既有投稿及媒体未修改。回滚会恢复按当前订阅逐请求切断 Guest 的旧行为，不建议在现场 Session 存续时回滚。

## 2026-08-15：每个 Host 仅保留一张当前 Guest 二维码

- `sessions` 保留为匿名 Guest 的短期权限边界，但生产 Worker 现强制同一 `host_id` 最多一条 `live` Session。新增同源 D1 迁移 `0013_one_live_session_per_host.sql`：先将过期 live Session 标为 `expired`，再以部分唯一索引 `sessions_one_live_per_host` 阻止一个 Host 并行存在两张有效 QR；历史 `revoked`/`expired` Session 仍保留给 ACK、到期清理和最小审计。
- `POST /v1/host/sessions` 改为幂等创建：当前 Host 已有未过期 live Session 时返回该 Session/原 QR（200），首次才创建（201）；并发设备争抢唯一索引时读取获胜者并返回同一二维码。返回查询始终按已认证 bearer 解析的 `host_id` 过滤，未增加 Session 枚举、跨 Host 可见性或公开 R2 访问。
- 已按迁移→Schema 核验→Worker 部署→smoke 固定顺序上线。生产 Worker 当前版本 `e4f49eb8-14f0-4d03-8c45-21d9bd78a545`；D1 显示 `0013` 无待执行、唯一索引存在，实时只读计数 `live_sessions=1`、`live_hosts=1`、`duplicate_live_hosts=0`，`/health` 返回 200。验证：`npx tsc --noEmit`、`npx wrangler check startup`、deploy dry-run、生产迁移/索引/重复数据查询、生产 deploy、HTTPS health、`git diff --check`。无回滚 SQL：如需回滚应用，保留索引仍安全；仅在确认无并发有效 QR 的维护窗口内才可显式 drop index。

## 2026-08-15：Apple Host 账号生产收尾与 Guest 数据永久清除

- 生产 Host 认证采用 Sign in with Apple 首次自动建号/后续登录：五分钟服务端 nonce 单次消费，Apple RS256/JWKS、issuer、精确 Bundle ID audience、`iat/exp` 验证；15 分钟 access token、仅保存 SHA-256 的单次轮换 refresh token、refresh 重放全族撤销与 `auth_epoch` 提升、服务端 Logout，以及七天绝对账号会话期限。Host 管理 Session、列举、下载、ACK 与 revoke 均为 bearer-only；旧 P-256/App Attest 只允许参与未绑定 Host 的一次性历史认领。
- 经产品所有者明确授权，生产 D1 永久删除 5 个 Session、6 条未 ACK `ready` 投稿和 13 个 capability；复核 `sessions=0`、`submissions=0`、`capabilities=0`，保留 `hosts=1`。旧 QR 全部失效。生产 R2 专用桶删除并同名重建，旧 9 个媒体对象不可恢复；新桶创建时间 `2026-08-15T08:39:40.802Z`、位置 WNAM，并恢复 `evb-private-media-expiry`（一天过期和一天 multipart abort）。`bucket info` 暂仍显示旧的 `9 objects / 1.54 MB` 聚合值，按 Cloudflare 指标延迟处理并继续复核，不能据此宣称监控指标已归零。
- 当前 Worker `/health` 正常，远端迁移列表无待应用项；验证通过 `npx tsc --noEmit`、`npx wrangler check startup`、`npx wrangler deploy --dry-run`、生产 D1 脱敏计数、R2 信息和 lifecycle、HTTPS health 与 `git diff --check`。iOS 最新包已移除日常 Apple 登录请求中的 `legacyHostID`/旧 Host 签名并覆盖安装真机；仍待人工登录后复核 active refresh/七天 Host session 至少各 1，再验证 Logout 后服务端撤销。

## 2026-08-15：修复已绑定 Apple Host 再次登录无法签发会话

- 真机连续两次表现为系统 Apple 授权完成但仍停留登录页。生产 D1 脱敏证据显示已有 1 个 Apple-bound Host，但 `auth_session_expires_at` 为空且有效 refresh token 为 0，证明失败发生在 Apple 验证之后、服务端 token 签发之前，并非客户端根视图切换。
- 根因是已绑定 Apple 的 Host 仍携带历史 `legacyHostID`，Worker 将它错误送入仅允许 `apple_subject IS NULL` 的首次认领分支，条件更新必然冲突。现在只有尚未 Apple-bound 的历史 Host 才进入认领；同一 Apple subject + 同一 Host ID 走正常再次登录并刷新七天绝对期限。若携带的 Host ID 与 Apple 已绑定 Host 不同仍返回 409，不放宽归属边界。
- 验证通过：`npx tsc --noEmit`、`npx wrangler check startup`、dry-run、`git diff --check`、生产部署。Worker 版本 `66c2c360-9b4b-457c-8dd2-6dab240c1738`。下一次真机登录后必须只读核验 `auth_session_expires_at` 非空且出现 active refresh token，不读取 Apple subject、token 或媒体内容。

## 2026-08-15：移除 Web Guest 自拍特效运行时

- 按产品决策，Web Guest 保留前置相机自拍（`capture="user"`）、相册选择、浏览器内 Canvas JPEG 压缩与最终图片预览，但不再提供或渲染任何自拍特效。图片仍不写入浏览器持久化存储；Canvas 重绘继续移除 EXIF，只有最终 JPEG 经既有受限 capability 上传。
- 已移除效果选择器、MediaPipe landmark/Canvas 特效代码、`@mediapipe/tasks-vision` 依赖，以及全部同源发布的 `public/vendor/mediapipe` 模型/WASM/JS 文件（约 23 MiB）。后端投稿、capability、媒体格式/大小限制和 Host 导入/ACK 契约均未变更；现有浏览器端 CSS 预览网格继续复用，未新增样式 token。
- 已同步官网 Privacy 与 Support，移除“自拍效果/landmark”表述，改为浏览器本机 JPEG 压缩且不收集人脸 landmarks 的当前事实。
- 验证：`npm install --package-lock-only --ignore-scripts`、`node --check web-guest/public/join.js`、定向 `rg` 确认实现与当前公开页面没有效果选择器、效果渲染或 MediaPipe 运行时依赖、`git diff --check`。历史交接记录保留过去的实现事实，不能作为当前功能入口。未覆盖：需要在 iPhone Safari 实测前置拍照、相册 JPEG/PNG、预览与发送；本次未部署 Pages，线上旧页面在同源 Pages 部署前仍可能保留旧静态资产。

## 2026-08-15：开发 Host ID 覆盖后的生产旧 Host 安全恢复

- 真机明确返回 previous Host ownership 无法证明；生产只读证据显示 Apple/StoreKit 已通过，但请求携带的本地 legacy Host ID 在生产不存在，因此 `authenticateHost` 没有找到 Host，也不会留下签名失败记录。生产真实旧 Host 仍有 4 个 live Session 和 5 条未 ACK ready 投稿，不能创建新 Host 或丢弃旧归属。
- Worker 新增严格限定的恢复分支：仅当请求中的 legacy Host ID 在生产完全不存在，且服务端验签后的 `originalTransactionId` 唯一指向一个尚未 Apple-bound 的旧 Host，才允许以 Apple 已验签 subject + 同一订阅链原子绑定该旧 Host。若请求 ID 存在但私钥签名失败，绝不回退；交易无唯一归属、已绑定或 Apple 身份冲突均拒绝。更新 SQL 同时条件约束 `apple_subject IS NULL` 与相同 `original_transaction_id`，并发只能一个成功。
- 这用于恢复此前开发后端与生产 App 共用 Keychain 覆盖 Host ID 的现场，不改变正常旧 Host 私钥认领规则，也不迁移/重写 Session、投稿或 R2 对象。验证通过：TypeScript、startup、dry-run、`git diff --check`、生产部署和 health。Worker 版本 `5da53b92-491a-43cd-b030-06bcd5f9d020`；待真机重新 Open Web Guest，随后必须核验 Host Apple-bound、refresh token active 和 5 条 ready 投稿可导入。

## 2026-08-15：修复 Sign in with Apple RS256 验签算法

- 真机分项错误为 `token claims`。根因是 Worker 把 Sign in with Apple identity token 错按 `ES256`/P-256 解析；Apple identity token 使用 `RS256`，Apple JWKS 对应 RSA 公钥，因此合法 token 在 header 算法检查处必然失败。
- Worker 现强制 header `alg=RS256`、按 `kid` 选择 `kty=RSA` 的 Apple JWK，并以 `RSASSA-PKCS1-v1_5` + SHA-256 验签。issuer、精确 Bundle ID audience、五分钟新鲜 `iat`、未过期、D1 单次 nonce 及 StoreKit 服务端验签均保持不变。旧 Host 的 P-256 安装私钥仍只用于原地认领，未被替换或放宽。
- 已同步修正文档中将 Apple identity token 误写为 ES256 的当前事实。验证通过：`npx tsc --noEmit`、`npx wrangler check startup`、`npx wrangler deploy --dry-run`、`git diff --check`、生产部署与 `/health`。生产 Worker 版本为 `6488c01f-8c03-4c14-bf31-ec9458389b88`；待真机重新主动创建 QR，确认进入 StoreKit 验证及旧 Host 原地认领。

## 2026-08-15：Apple 身份校验分项诊断

- 同一真机在放宽错误的 `exp - iat <= 15 分钟` 假设后仍返回身份校验失败，证明还有独立根因。Worker 现将身份失败安全拆为 nonce、audience、signature、Apple signing key、JWKS unavailable、claims 与 token format；响应和日志均不包含 token、Apple subject、nonce 值或签名内容。
- 生产 Worker `6aa2352d-e8a7-46ad-868a-ed3e7837c1e7` 已部署；该版本保留了错误的 ES256 假设，随后由真机 `token claims` 证据定位并在下一条记录修复。iOS 诊断包已安装到 Dylan iPhone 16。
- 验证：`npx tsc --noEmit`、startup、dry-run、生产 deploy、health、App 生命周期测试、真机构建、签名检查、覆盖安装与启动、`git diff --check`。下一步必须依据真机显示的阶段修复，不再调整其它身份控制。

## 2026-08-15：修复 Apple identity token 有效期错误拒绝

- 真机已返回 `apple_identity_verification_failed`，确认请求到达 Worker 且失败发生在 identity token 校验。根因是 Worker 错把 Apple identity token 的 `exp - iat` 限制为 15 分钟；15 分钟仅适用于本服务签发的 Host access token，不能作为 Apple token 的固定协议假设。
- 现在仍要求 Apple JWT 有效 RS256/JWKS、issuer、精确 Bundle ID audience、未过期、`iat` 不在未来且刚签发（最多五分钟），并继续要求本 Worker 签发且 D1 条件单次消费的五分钟 nonce。认证强度没有下降：即使 Apple token 自身有效期更长，也不能脱离单次 nonce 重放。
- 已执行 `npx tsc --noEmit`、`npx wrangler check startup`、`npx wrangler deploy --dry-run`、`git diff --check`、生产部署和 `/health`。Worker 版本 `9881b797-c462-4c94-9b8b-9960e1e95b1f`。下一步为真机重新主动创建 QR，验证 Host Apple 绑定、refresh 会话和新 QR；不应复用先前已消费的 nonce。

## 2026-08-15：Apple 登录后的 Host 会话创建失败诊断

- 只读生产证据显示，最近两次 Apple nonce 均被条件消费，但没有新增 Apple-bound Host，也没有 refresh token；这排除了 QR 域名、Pages DNS 与客户端未发送登录请求。旧 Host 仍存在但其历史订阅到期，不能据此删除 Event 或更改既有 Session。
- Worker 现将原统一的 `apple_sign_in_failed` 拆为不含 token/subject/nonce 的 `apple_identity_verification_failed` 与 `host_purchase_verification_failed`，日志仅记录 `identity` 或 `purchase` 验证阶段和错误类别。认证、nonce 单次消费、StoreKit 服务端验签、旧私钥认领、限流及 Host 对象授权均未放宽。
- 生产 Worker 已部署为 `3273e136-4768-4a81-8200-a9f5cf57f5fd`，`/health` 为 200。iOS 已映射两类错误：订阅失败提示先 Restore Purchases 后重试；身份失败提示重试。仍需安装本轮 iOS 包，重新主动创建 QR 一次后根据显示的精确类别做最终修复。

## 2026-08-15：Host Sign in with Apple 主认证已启用

- 生产 D1 已应用 `0011_apple_auth_challenges.sql`，Worker 版本 `2cba296d-4c97-40c7-a7ee-02605d931cd8` 已启用 `APPLE_HOST_AUTH_ENABLED=true`。`POST /v1/auth/apple/challenge` 返回仅五分钟有效、D1 条件单次消费的随机 nonce；`/v1/auth/apple` 验证 Apple JWKS、issuer、精确 audience、短期 `iat/exp`、nonce 和当前有效 StoreKit JWS。
- Worker 仅保存 Apple `sub`、认证 epoch 与 refresh token SHA-256 摘要；不保存 identity token、姓名或邮箱。access token 为带 issuer/audience/issued-at/15 分钟上限的 HMAC bearer token。refresh 重放会撤销该 Host 所有 refresh token 并递增 epoch，使旧 access token 立即失效。迁移完成的 Host 拒绝旧 P-256/App Attest 的敏感媒体操作；旧 Host 认领固定要求旧私钥签名及相同 `originalTransactionId`。
- 已执行 `npx tsc --noEmit`、`npx wrangler check startup`、远端迁移、schema `PRAGMA`、生产部署、匿名 challenge 201 与 `git diff --check`。待覆盖：真机 Apple 授权 + StoreKit Sandbox JWS 端到端、refresh replay 并发、迁移后旧私钥拒绝、Host A/B 的 list/download/ACK/revoke 401/410 回归。未完成这些用例前不得作为 App Store 发布放行证据。

## 2026-08-15：移除 Cloudflare 隔离开发后端

- 产品所有者授权下线仅用于 Xcode 调试的开发运行时。删除前只读核验开发 D1 有两条未 ACK 的 `ready` 测试投稿及三份临时媒体；这些内容没有导入生产，现已按授权永久删除且不可恢复。
- 已删除 Worker `event-voice-booth-web-guest-dev`、Pages `event-voice-booth-guest-dev`、私有 R2 `event-voice-booth-guest-media-dev`、D1 `event-voice-booth-guest-dev`，以及为枚举残留对象临时创建的清理 Worker。生产 Worker `event-voice-booth-web-guest`、生产 Pages、生产 R2 `event-voice-booth-guest-media` 和生产 D1 `event-voice-booth-guest-prod` 未改动。
- 本地已删除 `wrangler.development.toml` 与开发 Pages 构建脚本。验证：`wrangler r2 bucket list`、`wrangler d1 list`、`wrangler pages project list` 均不含开发资源；原开发 Worker/Pages URL 分别为 HTTP 404 / DNS 不可解析。不得重新创建测试或预览 Cloudflare 后端。

## 2026-08-15：Apple 登录迁移预部署安全收敛

- 已在生产 D1 应用 `0010_apple_host_auth.sql`，仅以可空 `apple_subject`、`auth_epoch` 与 refresh token 摘要表扩展既有 Host；不迁移、不重写任何现有 Session、投稿或 R2 对象。Worker 的 `AUTH_TOKEN_SECRET` 已作为 Cloudflare Secret 配置，未写入仓库。
- 安全复核发现一次性 Apple nonce、refresh 重放全族撤销、旧 P-256 迁移后降权仍未完整实现。因此生产 `APPLE_HOST_AUTH_ENABLED=false`：`/v1/auth/apple`、`/v1/auth/refresh`、`/v1/auth/logout` 一律返回 `503 host_auth_migration_unavailable`，现有 App Attest/P-256 Host/Guest 链路不受影响。不得在这些 P0 补齐、自动化越权/重放回归和 TestFlight 端到端验证前打开开关。
- 当前 Worker 版本 `a1254733-5c90-42ed-be1d-d9a44904cf00`。验证：`npx tsc --noEmit`、`npx wrangler check startup`、`npx wrangler deploy`、匿名 `/health` 返回 200、Apple 登录入口返回预期 503、`git diff --check`。未覆盖风险：Apple 登录客户端尚未接入，当前变更不是可发布的身份迁移完成态。

## 2026-08-15：Sign in with Apple 成为 Host 主身份（生产已部署，待 iOS 接入）

- 为解决每次 Sync/下载/ACK 绑定 App Attest assertion 与 signCount CAS 造成的现场 401、429、环境切换和恢复复杂度，Host 主认证迁移为 Sign in with Apple。Worker `POST /v1/auth/apple` 服务端验签 Apple identity token 的 RS256 签名、`iss`、Bundle ID audience、过期时间与单次 nonce，并同时继续服务端验签有效 `Host Monthly` StoreKit transaction；仅保存 Apple 稳定匿名 `sub`，不保存姓名、邮箱、identity token 或 authorization code。
- 成功登录签发 15 分钟 HMAC bearer access token 与 30 天、单次轮换的 refresh token。D1 仅保存 refresh token SHA-256 摘要；logout 递增 `auth_epoch` 并撤销 refresh token，立即使所有 access token 无效。Host 的创建、同步、下载、ACK、revoke、Replace 和 Stop 在 iOS 接入后可用 bearer，不再对每项操作要求 App Attest assertion。App Attest/P-256 仍保留为旧 Host 一次性认领与迁移窗口兼容，不作为已登录 Host 的请求主认证。
- 迁移 `0010_apple_host_auth.sql` 已在生产 D1 执行：`hosts.apple_subject`（唯一）、`auth_epoch`、同一 `original_transaction_id` 的唯一归属和 `host_refresh_tokens`。既有 Session、Guest 投稿、R2 对象、Guest QR 和 ACK 状态均不重建、不迁移、不改变归属；旧 Host 首次 SIWA 登录应携带 `legacyHostID` 并以旧 P-256 签名整个请求，Worker 原子绑定现有 Host 到 Apple `sub` 后保留同一 Host ID，因此原 Session 可继续同步/关闭。不能以本机 Event UUID、二维码或交易单独认领旧 Host。
- 已设置生产 Worker secret `AUTH_TOKEN_SECRET`（未写入仓库、日志或 D1），并部署 Worker `8afffcaa-7ec2-451e-9eb7-8f59c440d57e`。生产 migration history 已确认 `0010_apple_host_auth.sql`，`hosts` 新字段和 `host_refresh_tokens` 表真实存在，`/health` HTTP 200。验证：`npx tsc --noEmit`、`npx wrangler check startup`、`npx wrangler deploy --dry-run`、远端 migration/Schema 只读查询、`git diff --check`。
- iOS 尚未接入 SIWA，因此当前已发布客户端继续使用 legacy App Attest/P-256 路径，保持兼容。待 iOS 采用 `/v1/auth/apple`、`/v1/auth/refresh` 和 bearer 后，需要 TestFlight 验收：新 Host 登录/刷新/登出、旧 Host 原地认领并导入已有 ready 投稿、Host A/B 列表/下载/ACK/revoke 均为 401/410、access token 过期刷新、refresh 重放被拒绝、Stop/Replace 的 drain→revoke→final drain 不丢投稿。不得在 iOS 切换完成前删除 legacy App Attest 表字段或认证分支。

## 2026-08-15：区分 Host 不存在与可重试 assertion 401

- 开发 D1 证据显示 Host、Session 均存在，App Attest signCount 为 32 且无最终 assertion failure；投稿已被 App 保存到本地但服务端仍为 ready/未 ACK。33 个 challenge 对应 32 个成功 assertion，说明 ACK 阶段存在一次瞬时 401。旧客户端错误地把任何 Host API 的 `401 unauthorized` 都映射为“Host ID 不再接受”，可能诱导身份/QR 轮换。
- Worker 新增最小 `POST /v1/host/identity`：未知 Host 返回 410；存在 Host 必须以登记的 P-256 私钥签名才返回 `{accepted:true}`，不接受 assertion、不返回订阅、Session 或其它数据。普通敏感 API 的 401 不再能作为删除身份的唯一依据。开发 Worker已部署 `5ddca45b-2411-4ff7-97ff-827dfc4e839c`；无 Schema/R2/Pages 变更。
- 验证：`npx tsc --noEmit`、startup、dry-run、deploy 和 `git diff --check`。生产 Worker尚未部署此新增探测路由，待对应 Release/TestFlight 客户端采用后再同源发布。

## 2026-08-15：修复开发 Pages 有效二维码误报 410

- 开发 D1 证据确认新 Session `79f5433c-d064-469e-ba4e-e5b16252e750` 为 live、Session/订阅均未到期，开发 Worker 对同一 slug 的 `/access` 返回 204，但开发 Pages 返回 410。根因不是二维码或 App，而是首次 dev Pages 部署命令从项目根目录执行：Wrangler 编译了项目根 `functions/` 中指向生产 Worker 的 Function，而没有使用临时输出目录内已替换为 dev Worker 的 Function。
- `scripts/build-development-pages.sh` 现在输出并强制说明必须从生成目录执行 Wrangler，避免 Functions 解析回项目根。开发 Pages 已重新部署为 Production deployment `6e7e1db8`；正式 `https://event-voice-booth-guest-dev.pages.dev/join/<有效 slug>` 返回 200，`join.js` 与 CSP 均只允许 dev Worker。现有二维码无需 Replace，刷新即可。
- 验证包括同一 slug 的 dev Worker access 204、正式 dev Pages join 200、dev `join.js` API URL、CSP、脚本语法及 `git diff --check`。无 Worker、D1、R2、生产 Pages 或 iOS 变更。

## 2026-08-15：部署完全隔离的 Xcode Debug Web Guest 后端

- 为支持 Xcode 真机 Development 签名调试，新增独立 Worker `event-voice-booth-web-guest-dev`、D1 `event-voice-booth-guest-dev`（ID `d06ce10e-1bda-4c34-a60c-d8f6563eb890`）、私有 R2 `event-voice-booth-guest-media-dev` 与 Pages `event-voice-booth-guest-dev`。开发环境不绑定生产 D1 `97876567-…` 或生产 R2；首次核验 dev hosts/sessions/submissions 均为 0，而生产 Host 仍为 1，证明数据面分离。
- Worker 新增显式 `APP_ATTEST_DEVELOPMENT`：生产 `wrangler.toml` 固定 `false`，开发 `wrangler.development.toml` 固定 `true`。开发仍完整验证 Apple development App Attest、StoreKit JWS、Host P-256 签名、一次性 challenge、signCount CAS、对象授权、限流、配额和 ACK；没有匿名注册或安全绕过。开发 Worker 版本 `db64e5e7-9246-4608-bac2-7051877bf091`，`IP_HASH_SALT` 仅保存为该 Worker secret；生产 Worker 已以显式 `false` 重新部署为 `a985fc2d-3b51-4626-875f-fcb58f5031df`，无生产数据变更。
- Dev D1 已从空库执行同源 0001–0009 全量迁移并核验全部 migration history 与必需表。Dev R2 未开放公开访问，所有对象 1 天过期；cron 每 5 分钟运行。Dev Pages Production deployment `95d4822a`，正式 URL `https://event-voice-booth-guest-dev.pages.dev`；构建脚本从生产源生成临时目录并仅替换 Worker URL/CSP，拒绝残留生产 API，避免生产 Pages 同时信任开发 Worker。
- 验证：`npx tsc --noEmit`、`npx wrangler check startup --config wrangler.development.toml`、dry-run、部署、dev/prod D1 只读隔离查询、dev Worker health 200、dev Pages 无效链接 410、R2 lifecycle 查询和 `git diff --check`。回滚为删除/停用三个 `*-dev` Cloudflare资源并恢复 Debug URL；不得删除生产资源。

## 2026-08-15：修复 Host Sync 误触发 429

- 生产 D1 的脱敏限流证据显示当前 Host 的旧 `host:<id>` 固定窗口计数已达 128，而注册 IP 桶只有 3 次。根因是 assertion challenge（配置 180/小时）和目标敏感请求（配置 120/小时）错误共用同一个 `host:<id>` scope；每次列表、媒体下载、ACK、订阅刷新等业务请求会先领 challenge，导致同一业务操作在共享桶计数两次，并由 challenge 把计数推过 120，随后真正 Sync 请求持续返回 429。
- Worker 已把两个控制拆为独立固定窗口：`host:challenge:<id>` 每小时 180 次、`host:sensitive:<id>` 每小时 120 次。旧共享桶不删除、不改写，但新部署不再读取它，因此合法 Sync 可立即恢复；攻击者仍同时受 Host 签名、App Attest assertion、一次性 challenge、nonce 和两个独立限流桶约束。
- 已执行 `npx tsc --noEmit`、`npx wrangler check startup`、`npx wrangler deploy --dry-run`、旧共享 scope 定向 `rg`、`git diff --check` 并部署生产 Worker `a68c6151-2e07-46c9-875c-8c455851ea31`。无 D1 Schema、迁移、R2、Pages 或 iOS 构建变更。

## 2026-08-15：Host 注册 IP 限流调整为每小时 120 次

- 根据产品所有者指示，生产 Worker 的 Host 注册恢复入口 `host-register:ip` 固定窗口限流由每 IP 每小时 60 次调整为 120 次，用于缓解合法设备在 App Attest/网络恢复期间触发 429。Host 敏感 API 仍保持每 Host 每小时 120 次、assertion challenge 每 Host 每小时 180 次；App Attest、StoreKit JWS、Host 私钥签名、一次性 challenge、对象级授权、Guest 限流和 Event 配额均未放宽。
- 已执行 `npx tsc --noEmit`、`npx wrangler check startup`、`npx wrangler deploy --dry-run`、`git diff --check` 并部署生产 Worker `ac69a9e9-f5f6-44a8-944e-d1d04005d690`。无 D1 Schema、迁移、R2、Pages 或 iOS 构建变更。既有固定窗口计数不会被清空；如果当前 IP 已达到旧窗口阈值但尚未达到 120，可立即重试，达到 120 时仍须等待 `Retry-After`。

## 2026-08-15：支持 Replace QR 的可重试旧 Session 收尾

- iOS Replace 流程现为旧 Session 导入/ACK → revoke → 最终导入/ACK → 创建并切换新 Session。为处理 revoke 成功后最终拉取网络失败的重试，Worker 对同一 Host 重复 revoke 已 revoked Session 返回幂等成功；不会增加 revoke version、重新开放 Guest 写入或改变其它 Host 的对象级授权。
- 已部署 Worker `17e66ead-1db9-42c8-8b02-740729593138`。验证：`npx tsc --noEmit`、`npx wrangler check startup`、`npx wrangler deploy --dry-run`、`git diff --check`。无 Schema、R2、媒体或 Pages 变更。

## 2026-08-15：修复 Web 自拍效果不可见与 finalize_failed

- 自拍效果路径原本会对拍后 Canvas 尝试本机 MediaPipe/Canvas 合成，但网页只列出文件大小、不展示最终 JPEG，并且无人脸/WASM 失败静默回退，用户无法确认效果是否真正进入待上传图片。现在页面直接预览最终将上传的去 EXIF JPEG，并对非 Natural 自拍明确显示 `effect applied` 或 `no face found, original used`；Object URL 仅在内存使用并于替换/离页释放，不持久化、不上传原图或 landmarks。页面基线继续为现有 Guest composer，复用现有颜色、圆角和响应式网格，未新增样式 token。
- 生产 D1 显示失败尝试的音频/照片 capability 均为 `uploaded`，Session `used_bytes=0`、`submission_count=0` 且没有 submission。根因是 Worker `INSERT INTO submissions` 的 `VALUES` 比 `.bind(...)` 多一个占位符，D1 每次在 finalize 原子批次抛错并返回 `finalize_failed`。已修正占位符数量；reservation、R2 quarantine→pending 复制、ready 发布、capability finalization 和失败补偿语义均保持不变，无 Schema 迁移。
- 已部署 Worker `0aa9c414-f010-4f2b-a718-34bfbaa2f1ab` 与 Production Pages `fd86a710`。验证：`node --check public/join.js`、Pages Function syntax、`npx tsc --noEmit`、`npx wrangler check startup`（约 46.7 ms）、`npx wrangler deploy --dry-run`、`git diff --check`；正式 Guest page/join.js 均 HTTP 200，并包含最终 JPEG 预览与效果结果文案。
- 未覆盖：自动化无法在无真实 iPhone Safari 相机和人脸输入时验证每种 landmark 视觉对齐；需 Guest 重新拍摄正脸并目视确认缩略图。失败页面若仍保持上传 ID，可直接再次点击 Send；若页面已刷新则需重新录音/拍照。提交成功后还需 Host App 同步，验证本机原子保存、ACK 与 Guest `Saved by the host`。

## 2026-08-15：修复所有有效 QR 在 Pages 入口被误判 410

- 生产证据显示同一完整 43 字符 capability slug：Worker `/v1/guest/<slug>/access` 返回 204，D1 Session 为 `live` 且 Host 订阅未到期，但 Pages `/join/<slug>` 返回 410。根因是路由文件 `functions/join/[[slug]].js` 使用 catch-all 参数，Cloudflare Pages 生产运行时将 `context.params.slug` 作为数组提供，旧代码只接受字符串，因此所有合法二维码都在边缘被误判无效。
- Pages Function 现在兼容单 segment 数组，同时严格拒绝 0 个或多个 segment，避免 `/join/<slug>/extra` 被折叠为同一 capability；slug 字符集、最小长度、Worker access、Host revoke 和统一 410 语义均保持不变。
- 已部署 Production Pages deployment `edb39219-98cc-4209-b11d-52a4994398e8`（source `20f0387`）。同一现有 live slug 在部署预览域名和正式 `https://event-voice-booth-guest.pages.dev` 均返回 HTTP 200 HTML；伪造短 slug 与合法 slug 后追加额外路径均返回 410。验证命令：`node --check functions/join/[[slug]].js`、正式 Worker/Pages `curl` 对比、负面路径 `curl`、`git diff --check`。
- 没有修改 Worker、D1 Schema、Session、Host、R2、订阅、限流或媒体；现有二维码无需替换，重新打开即可。回滚入口为上一 Production Pages deployment `0f12f91a-9cfb-4f2f-a5f6-a775b84d4e82`，但该版本会恢复所有合法二维码误报 410 的缺陷。

## 2026-08-15：Replace Web Guest QR 持续 401 的生产诊断部署

- 生产 D1 只读查询确认 `hosts=0`、`sessions=0`，因此客户端旧 Host 身份确实已失效；当前 401 发生在完整的新 Host 注册阶段，而不是旧 Session 替换或对象级授权阶段。没有修改或删除 D1/R2 数据。
- 发现生产 Worker 仍运行较早的通用 `host_verification_failed` 401，无法区分 Apple App Attest 与 StoreKit JWS 验证失败。已在保持全部安全门禁不变的前提下部署仓库现有的分阶段诊断：注册失败现在仅返回 `app_attest_verification_failed` 或 `storekit_verification_failed`，日志只记录验证阶段和异常类型，不记录 JWS、Host 公钥、IP 或用户数据。生产版本 ID 为 `577c93a4-a54f-4de7-97e2-a8447ff48f3f`。
- 部署前验证：`npx tsc --noEmit`、`npx wrangler check startup`（本地分析启动约 52.9 ms）、`npx wrangler deploy --dry-run`；部署后 `/health` 为 HTTP 200。生产 D1 Schema、R2、接口成功响应、认证授权强度和限流配置均未改变。
- 尚需产品所有者在真机再次点击 `Replace Web Guest QR`，再依据这一次的脱敏失败阶段修复实际 App Attest 或 StoreKit 根因；在新 Host 成功写入且新 Session/QR 端到端通过前，不得宣称 401 已修复。

## 2026-08-15：Sandbox 订阅加速到期导致新 Guest 链接 410

- 新 Host 与 Session 已成功写入生产 D1；只读查询确认 Session 仍为 `live` 且 24 小时 TTL 正常，但 Host 的 Sandbox 月订阅仅比 Session 创建时间晚 160 秒到期。`liveSession` 同时校验 Session 与 Host 订阅有效期，因此随后返回 410 符合既有 fail-closed 契约，不是 Pages 路由、QR 或对象授权缺陷。
- Worker 本轮没有代码、Schema、R2 或部署变更。客户端已改为每次手动/前台同步前提交 Apple 最新有效 JWS 刷新 Host 到期时间；服务端继续独立验签并拒绝过期交易，不接受本地布尔值或人为延长 Sandbox 到期时间。

## 2026-08-15：生产 Worker 仅接受 Host Monthly

- 为配合 App 1.1.5 (27) 的付费模型，生产 Worker 的 StoreKit 服务端验签白名单已移除 `com.eventvoicebooth.host.lifetime`，仅接受有效自动续期订阅 `com.eventvoicebooth.host.monthly`；旧 Lifetime 交易不再创建或续用 Web Guest Host 能力。
- 已执行 `npx tsc --noEmit`、`npx wrangler check startup`、`npx wrangler deploy --dry-run` 并部署生产版本 `445c8d3d-1a4f-4a61-bfa9-041aab13f494`。匿名无效 access 保持 410；本次没有 D1 Schema、R2 对象或用户媒体迁移。
- 兼容性：旧 Lifetime 买家必须订阅 Host Monthly 才能使用 Web Guest Host 能力。回滚入口是从部署前同源修订重新构建 Worker 并部署；不得仅恢复客户端权益而让服务端继续拒绝。

## 2026-08-15：Web Guest 生产 Cloudflare 与官网同步发布

- 按产品所有者授权，已恢复 **单一生产环境**：Worker `event-voice-booth-web-guest`、Pages `event-voice-booth-guest` 和私有 R2 `event-voice-booth-guest-media`。没有创建测试环境、测试账号、调试 API、公开 R2 域名或 Preview Worker URL；Worker 明确 `preview_urls = false`，唯一写路径继续是有 App Attest、StoreKit JWS、Host 私钥签名、一次性 assertion、对象授权与限流保护的生产 Host API。
- 生产 D1 使用独立空库 `event-voice-booth-guest-prod`（ID `97876567-34bd-4106-b221-61d4e57fb9e2`），未复用已下架运行时的审计库。新增 `0001_initial_schema.sql` 与历史 `0002`–`0009` 严格串行，已从空库完成全量迁移并核验 `submission.expires_at`、`hosts.subscription_expires_at`、`hosts.last_assertion_failure` 及全部 9 条 migration history；后续不得直接执行 schema.sql 代替迁移。
- R2 未开启公开访问，只绑定 Worker；所有对象在 1 天后过期，未完成 multipart 1 天中止。Worker secret 仅有部署控制台保存的 `IP_HASH_SALT`，未写入仓库、D1、日志或变量；生产 cron 每 5 分钟清理过期的 ready/未 finalize 媒体。Worker 当前版本 `f7f93129-3f00-4a95-9e8b-c9155127c4d1`，Pages Production deployment `0f12f91a-9cfb-4f2f-a5f6-a775b84d4e82`，地址分别为 `https://event-voice-booth-web-guest.event-voice-booth-web-guest.workers.dev` 和 `https://event-voice-booth-guest.pages.dev`。
- 匿名 HTTPS 验证：Pages 根页为 200 且带 CSP、`no-store`、防嵌入和最小权限策略；Worker 无效 Guest access 为 410；Pages `/join/not-a-valid-slug` 同样为 410，证明公开静态重写不会绕过 revoke/access gate。官网首页、隐私页、支持页的文案已同步 Web Guest 临时私有存储、24 小时删除、Host stop 撤销、浏览器本机自拍效果及 US$9.99/月 Host Monthly。站点 PR [#7](https://github.com/dylan120/event-voice-booth-site/pull/7) 已合并（merge `413821c03e4eda0d1d14734d16f131352918f056`）；GitHub Pages run `31862171414` 成功，首页、隐私页和支持页已匿名 HTTPS 200 复核为新事实。
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
