# SubHarbor

自托管的代理订阅管理台，使用 TypeScript、Node.js、Fastify、React 和 Rsbuild。

汇总机场订阅和自建节点，为每份独立配置选择来源、规则、DNS 和脚本，生成 mihomo、Clash legacy 或 sing-box 订阅链接。

## 功能

- 汇总订阅和手动节点，过滤、去重、重命名，按策略更新来源。
- 创建独立配置，设置专属规则、策略组、DNS 和 JS 后处理。
- 输出完整配置或节点片段，签发、固定、到期和撤销分享链接。
- 管理员登录、加密存储，以及备份导出与恢复。

当前为开发版本，iOS 专用格式尚未实现。支持范围和已知限制见[兼容文档](docs/compatibility.md)。

## 快速开始

推荐 Node.js 24 LTS，开发也支持 Node 22.19+；使用 pnpm 11.21。

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm password
openssl rand -hex 32
```

将密码摘要和随机密钥分别填入 `.env` 的 `SUBHARBOR_ADMIN_PASSWORD_HASH` 与 `SUBHARBOR_SECRET_KEY`，设置管理员用户名和访问地址。保留主密钥，不要将 `.env` 提交到 Git。

```sh
pnpm build
pnpm start
```

打开 `http://localhost:3000`，登录后添加来源、创建配置，再签发订阅链接。Docker、公网部署及其他环境变量见[部署说明](docs/guide.md#docker)。

仅体验界面时，可运行 `pnpm demo`，打开 `http://localhost:31457`，使用 `preview` / `synthetic-preview-only` 登录。演示只绑定本机，使用不可连接的合成节点；重启后数据重置。

## 文档

- [部署与使用](docs/guide.md)：本地运行、Docker、独立配置和开发验证。
- [JS 后处理](docs/guide.md#后处理)：脚本示例、执行阶段、权限与发布行为。
- [备份与恢复](docs/guide.md#备份)：导出、恢复和主密钥保管。
- [协议兼容范围](docs/compatibility.md)：支持的输入与输出、客户端限制和验证方式。
- [贡献指南](CONTRIBUTING.md) · [安全说明](SECURITY.md)

代码采用 [MIT](LICENSE)；第三方规则及工具遵循各自许可证，项目不打包整个第三方规则库。
