# AI 交接记录

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
