# 部署与使用说明

[返回项目首页](../README.md) · [协议兼容范围](compatibility.md)

本页介绍部署配置、后处理、订阅发布与备份。协议和客户端限制见兼容文档。

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

开发前端热更新时使用两个终端运行 `pnpm dev` 与 `pnpm dev:web`，将 `SUBHARBOR_PUBLIC_URL` 设置为 `http://localhost:3001` 并从 3001 访问；Rsbuild 代理 API 和订阅请求到 3000。

## Docker

```sh
docker compose up --build -d
```

镜像使用 Node 24、非 root 用户和持久化数据卷。Compose 默认只在本机暴露 3000，公网域名通过 HTTPS 反向代理访问，`SUBHARBOR_PUBLIC_URL` 必须与外部访问的 origin 完全一致。示例见 [deploy/nginx.conf](../deploy/nginx.conf)。可信反向代理范围通过 `SUBHARBOR_TRUST_PROXY` 明确设置；订阅路径关闭原始访问日志及公共缓存。

管理员、主密钥、密码配置支持对应的 `_FILE` 变量读取 Docker Secret。更换主密钥会使旧数据库不可解密，不要在升级时重新生成。源 HTTP 默认禁止，确有需要时由部署者设置 `SUBHARBOR_ALLOW_HTTP_SOURCES=true`；私网地址始终禁止。

## 独立配置

先添加订阅或手动节点来源，再创建配置，选择来源、追加节点、规则包、专属规则、DNS、策略组和脚本。配置可以任意命名；名称只用于显示，不会触发家庭、公司或路由器等预设行为。

每个分享链接绑定配置 ID、目标格式和输出模式，支持到期、固定版本和撤销。完整配置与节点片段的用途见[协议兼容范围](compatibility.md)。

## 后处理

在配置中绑定脚本，并为脚本选择执行阶段和目标格式。同一阶段按配置中选定的脚本顺序执行，只运行适用于当前目标格式的脚本。

| 阶段     | 输入与返回值           | 执行位置                         |
| -------- | ---------------------- | -------------------------------- |
| `nodes`  | 内部节点数组           | 聚合后、目标兼容过滤与配置渲染前 |
| `config` | 当前目标格式的配置对象 | 渲染后、最终校验与序列化前       |

`context` 提供 `target`、`configId` 和配置填写的 `params`。以下示例用于 `config` 阶段的 mihomo 完整配置：

```js
function transform(input, context) {
  if (context.target === 'mihomo') {
    input.rules.unshift('DOMAIN-SUFFIX,example.com,DIRECT');
  }
  return input;
}
```

脚本由独立子进程中的 QuickJS WASM 执行，只支持同步 `transform`，必须返回可 JSON 序列化的结果。运行时限制计算时间、内存及输出大小；脚本不能使用 Node、文件、网络、环境变量或 npm 模块。节点结果和最终配置分别校验，校验通过后才能发布。脚本只在预览或后台生成时执行，订阅拉取读取已发布产物，不触发脚本。

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
