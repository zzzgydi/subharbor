# SubHarbor

自托管的代理订阅管理台，使用 TypeScript、Node.js、Fastify、React 和 Rsbuild。

把机场订阅和自建节点集中管理，再创建任意名称的独立配置。每份配置选择来源、设置自己的规则、DNS 和后处理脚本，生成 mihomo、Clash legacy 或 sing-box 订阅链接。名称只是显示标签，不决定行为。

## 当前功能

- 管理 HTTPS 订阅、手动节点和 `.list` 规则包（提供 ACL4SSR 引用入口，可设置默认动作）；设置手动、间隔或带时区的 cron 更新。
- URI/Base64、Clash/mihomo `proxies`、sing-box 节点列表输入；节点过滤、连接参数去重、重命名、排序。
- 独立配置、专属规则、自定义策略组、DNS、配置复制和预览。
- mihomo/Clash legacy YAML、sing-box JSON，完整配置或节点片段。
- 环境变量管理员、session、CSRF 校验；签发、到期、固定版本、撤销订阅链接。
- QuickJS WASM 子进程运行同步 JS，限制计算、内存及输出；结果校验后发布。
- 加密 SQLite 数据、重启恢复、最后成功版本和加密备份导出与恢复。

这是首个可运行开发版本。目标原生规则资源、设备 TUN 预设、任意字段覆盖、iOS 专用适配器、部分协议参数和真实设备验收仍在开发。当前 DNS 表单接受 IP 地址，过滤使用普通文字匹配。服务不会安装 VPS、转发代理流量或执行客户端控制。

## 本地演示

安装依赖后执行 `pnpm demo`，打开 `http://localhost:31457`，使用 `preview` / `synthetic-preview-only` 登录。演示绑定本机，使用不可连接的合成节点和独立临时数据库，重启演示会创建新数据。真实订阅请使用下面的持久化部署方式。

## 本地运行

Node.js 24 LTS 推荐；开发也支持 Node 22.19+。使用 pnpm 11.21。

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm password
openssl rand -hex 32
```

把生成的密码摘要填到 `.env` 的 `SUBHARBOR_ADMIN_PASSWORD_HASH`，把随机密钥填到 `SUBHARBOR_SECRET_KEY`。管理员用户名、数据目录及对外基址也在该文件设置。密码摘要与明文密码二选一；明文密码至少 12 字符。不要把 `.env` 加入 Git。

```sh
pnpm build
pnpm start
```

浏览器打开 `http://localhost:3000`。管理台从 `.env` 登录，先添加来源，再创建配置，最后在“订阅链接”页签发链接。令牌只展示一次，遗失时重新签发。

开发前端热更新时使用两个终端运行 `pnpm dev` 与 `pnpm dev:web`，将 `PUBLIC_URL` 设置为 `http://localhost:3001` 并从 3001 访问；Rsbuild 代理 API 和订阅请求到 3000。

## Docker

```sh
docker compose up --build -d
```

镜像使用 Node 24、非 root 用户和持久化数据卷。Compose 默认只在本机暴露 3000，公网域名通过 HTTPS 反向代理访问，`SUBHARBOR_PUBLIC_URL` 必须与外部访问的 origin 完全一致。示例见 [deploy/nginx.conf](deploy/nginx.conf)。可信反向代理范围通过 `SUBHARBOR_TRUST_PROXY` 明确设置；订阅路径关闭原始访问日志及公共缓存。

管理员、主密钥、密码配置支持对应的 `_FILE` 变量读取 Docker Secret。更换主密钥会使旧数据库不可解密，不要在升级时重新生成。源 HTTP 默认禁止，确有需要时由部署者设置 `SUBHARBOR_ALLOW_HTTP_SOURCES=true`；私网地址始终禁止。

协议范围与验证版本见 [docs/compatibility.md](docs/compatibility.md)。

## 协议兼容

首版支持 SS、VMess、Trojan、HTTP、SOCKS5、VLESS TLS/REALITY/Vision、Hysteria2、TUIC 的常用 URI 和字段。TCP、WS、gRPC 仅用于相应支持组合；SS 插件、链式节点、mux、关闭 UDP、部分扩展设置暂不支持。未知节点字段会被诊断并排除，避免转换时悄悄丢弃。解析失败显示诊断，零有效节点拒绝更新。

Clash legacy 会排除 VLESS/REALITY、Hysteria2、TUIC 和不支持的参数；严格模式遇到不兼容节点即拒绝生成。支持 Clash 风格配置不代表使用 legacy Clash 内核，mihomo 客户端请选择 mihomo 输出。

完整配置默认使用 loopback mixed 入口，TUN 设置由客户端负责。节点片段供 OpenWrt 插件等自行集成，不能当作所有客户端通用的完整订阅。配置结构校验与真实设备可用性是不同验收步骤。

## 后处理

```js
function transform(input, context) {
  if (context.target === 'mihomo') {
    input.rules.unshift('DOMAIN-SUFFIX,example.com,DIRECT');
  }
  return input;
}
```

脚本在配置里显式绑定，支持 nodes/config 两个阶段。context 提供 target、configId、params；脚本不能使用 Node、文件、网络、环境变量或 npm 模块。代码只在预览/后台生成时执行，订阅拉取不触发执行。

普通生成失败保留旧成功配置。来源变化、配置停用、来源范围或节点筛选变化会立即停发旧配置，防止范围收缩后继续分享旧节点。撤销链接只能阻止未来拉取；已下载的节点凭据如需收回，必须在提供商或 VPS 侧更换。

## 备份

“更新记录”页可导出与恢复备份。管理员登录后也可调用 `GET /api/backup` 导出加密 JSON，使用带 CSRF 的 `POST /api/backup/restore` 恢复。主密钥必须另外备份，恢复会撤销管理会话。建议升级前导出备份；不要将运行中的 SQLite 主文件单独复制而遗漏 WAL。首版只支持单实例及本地数据卷。

## 开发验证

```sh
pnpm typecheck
pnpm test
pnpm build
```

测试使用 `.example` 合成节点，检查配置隔离、改名、撤销与条件请求、持久化、协议参数、JS 权限和资源限制，不连接真实代理服务。

代码采用 MIT；第三方规则及工具有各自许可证。项目只提供规则目录和引用能力，不把第三方规则仓库整体复制进发行包。
