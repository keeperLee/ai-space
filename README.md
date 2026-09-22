# AI Space

独立的个人项目门户，提供统一登录、SQLite 用户管理与项目导航。

## 项目结构

- `index.html`：门户和首次管理员初始化入口。
- `content/projects.js`：项目导航配置，后续按需添加。
- `server/`：统一认证后端。
- `data/`：本机私有数据库，不提交 Git，不发布到 Pages。
- `projects/agent-learning/`：Git 子模块，引用现有 [Agent 学习平台](https://github.com/keeperLee/agent-learning-platform)，保留原仓库与提交历史。

## 启动

需要 Node.js >= 22.13。

```sh
git clone --recurse-submodules https://github.com/keeperLee/ai-space.git
cd ai-space
npm run dev
```

访问 http://127.0.0.1:5173/。首次 admin 密码为空且不能登录；在服务器本机首次设置后启用。密码只保存 scrypt 加盐哈希。门户和同站点子项目共用 HttpOnly Cookie 和同一个数据库，不必再次登录。

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
```

门户将该项目的 API 请求接到共享认证后端，所有 `/projects/` 资源都需要有效登录会话。外部独立域名不自动共享会话。

## GitHub Pages

Pages 地址：https://keeperlee.github.io/ai-space/

GitHub Pages 不支持 Node 与 SQLite，因此仅发布明确标注的部署状态页；不会上传数据库、账号文件或项目课程。完整门户需要部署到支持 Node 和持久化磁盘的服务器，当前尚未配置。`npm run build:pages` 只输出公开状态页至 `dist/`。

## 验证

`npm test` 执行课程校验及临时 SQLite 的 HTTP 认证、权限、重启持久化和跨项目会话测试，不修改真实管理员密码。
