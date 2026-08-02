# AI 交接记录

## 2026-08-03 — 工作区目录迁移

- 正式项目路径为 `/Users/weijianliu/project/iosapp/sites/event-voice-booth-site`，Git 顶层目录已核对为该路径。
- 独立仓库基线为 `main` 分支 `b1da5ad9834bfbe283a931b641ed3a457cc5bd07`，迁移前与 `origin/main` 一致且工作树干净；目录迁移未执行检出、重置或代码覆盖。
- 本次仅修正迁移后的跨项目文档链接并补齐文档入口，不修改站点页面或产品事实。
- 验证命令：`git diff --check`、`git rev-parse --show-toplevel`、`git status --short --branch`。
- 未覆盖风险：本项目尚无确定性站点验证脚本；发布前仍需人工验证 `/`、`/privacy/`、`/support/` 的 HTTPS 匿名访问与页面内容。
- 旧工作区根仓历史的恢复入口由工作区治理记录统一维护；不得从旧根仓检出覆盖本独立仓库。
