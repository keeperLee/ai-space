# AI Space

独立的个人项目门户：提供项目导航与统一登录，并作为 [Agent 学习平台](https://github.com/keeperLee/agent-learning-platform) 的入口。

## 访问模式

`assets/js/access.js` 是决定「要不要登录」的唯一开关。前端、服务端与构建脚本都读它，避免出现「界面放开了但服务端还在拦」这类不一致。

| 设置 | 行为 | 适用场景 |
| --- | --- | --- |
| `open: true`（当前） | 不校验登录，任何人打开即可浏览门户与全部课程；启动时不请求 `/api/session` | GitHub Pages 等纯静态托管 |
| `open: false` | 恢复登录门禁，由 `server/auth.mjs` 校验会话 | 自建 Node 服务器 |

公开访问模式下：

- 顶栏账号入口自动隐藏，不出现点了没反应的按钮
- `scripts/serve.mjs` 的三处门禁（`/projects/*`、`content/projects.js`、`content/chapters/*`）一并放行
- `npm run build:pages` 可正常执行；门禁模式下会**直接拒绝构建**，避免把需要登录的站点发到静态托管

> 学习项目仓库里有一份同名副本 `projects/agent-learning/assets/js/access.js`，两边需要一起改，
> 否则会出现「门户放开了但学习项目还在拦」。

## 项目结构

- `index.html`：门户。公开访问模式下直接展示项目列表。
- `assets/js/access.js`：访问模式开关（见上）。
- `content/projects.js`：项目导航配置，后续按需添加。
- `server/`：统一认证后端（SQLite + scrypt）。
- `projects/agent-learning/`：Git 子模块，引用现有 [Agent 学习平台](https://github.com/keeperLee/agent-learning-platform)，保留原仓库与提交历史。
- `scripts/build-pages.mjs`：把门户与子模块内容打包成可发布的静态站点。
- `data/`：本机私有数据库，不提交 Git，不发布到 Pages。

## 启动

需要 Node.js >= 22.13。

```sh
git clone --recurse-submodules https://github.com/keeperLee/ai-space.git
cd ai-space
npm run dev
```

访问 http://127.0.0.1:5173/。

以下仅在 `open: false` 时适用：首次 admin 密码为空且不能登录，需在服务器本机首次设置后启用；密码只保存 scrypt 加盐哈希。门户和同站点子项目共用 HttpOnly Cookie 和同一个数据库，不必再次登录。

首次部署前在本机完成初始化，再设置 `PUBLIC_ORIGIN=https://你的域名` 并通过 HTTPS 反向代理运行；指定 `DB_PATH` 可将数据库放到持久化磁盘。PUBLIC_ORIGIN 已配置时关闭首次初始化接口。不要发送或提交数据库、密码、私钥。

## 更新已有项目

Agent 项目继续在原仓库维护。门户固定引用一个已测试的提交版本；升级时执行：

```sh
git submodule update --init --recursive
git -C projects/agent-learning fetch origin
git -C projects/agent-learning checkout origin/main
npm test
git add projects/agent-learning
git commit -m "chore: update agent learning project"
git push
```

推送后 Pages 工作流会自动重新构建并发布。

## GitHub Pages

Pages 地址：https://keeperlee.github.io/ai-space/

公开访问模式下门户可以整体静态发布，因此 Pages 上是**完整可用的站点**：

- `npm run build:pages` 把门户与子模块内容打包到 `dist/`
- `.github/workflows/deploy-pages.yml`：检出子模块 → `npm run validate` → `build:pages` → 发布 `dist`
- 产物只包含站点真正用到的文件，**不含**数据库、账号文件、`server/`、`scripts/`、`examples/`

> GitHub Pages 不支持 Node 与 SQLite，登录门禁与用户管理在 Pages 上不可用 —— 这正是需要 `open: true` 的原因。
> 若日后要恢复登录并部署到服务器，把两份 `access.js` 都改回 `false` 即可，账号体系原样保留。

## 验证

`npm test` 执行课程校验及临时 SQLite 的 HTTP 认证、权限、重启持久化和跨项目会话测试，不修改真实管理员密码。

`scripts/auth.test.mjs` 按当前访问模式断言：公开访问下未登录应拿到 200，门禁模式下应被重定向到登录页。因此切换开关不需要改测试。
