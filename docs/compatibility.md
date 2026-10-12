# 首版兼容范围

配置名称不会选择协议、设备或规则。用户分别设置配置字段，分享链接固定绑定配置 ID、目标格式和完整/节点模式。

| 输入能力                                              | mihomo       | Clash legacy      | sing-box         |
| ----------------------------------------------------- | ------------ | ----------------- | ---------------- |
| SS，无插件                                            | 支持         | 支持；排除 SS2022 | 支持             |
| VMess TCP/WS                                          | 支持         | 支持              | 支持             |
| VMess gRPC                                            | 支持         | 排除              | 支持             |
| Trojan TCP/WS/gRPC                                    | 支持         | 排除 gRPC         | 支持             |
| VLESS TLS、REALITY TCP、Vision                        | 支持         | 排除              | 支持             |
| HTTP/HTTPS、SOCKS5                                    | 支持常用认证 | 支持常用认证      | 支持常用认证     |
| Hysteria2、salamander、TUIC                           | 支持常用参数 | 排除              | 支持常用参数     |
| DOMAIN、DOMAIN-SUFFIX、DOMAIN-KEYWORD、IP-CIDR/6 list | 支持         | 支持              | 转为 route rules |
| SS 插件、mux、链式、UDP 禁用及未知节点字段            | 诊断并排除   | 诊断并排除        | 诊断并排除       |
| IP-ASN、GEOIP、MRS/SRS、远程 provider                 | 暂不支持     | 暂不支持          | 暂不支持         |

这里的“支持”表示解析与输出已实现。合成样例覆盖常见参数；没有连接真实代理节点，不能据此保证每种服务端实现可用。输入只提取节点，完整上游配置的规则、DNS 与 provider 不会自动递归导入。

规则包默认动作只应用于未写动作的 list 条目；明确写出的动作仍保留。专属规则先于共享规则包，规则包按配置选定顺序合并，最后加入兜底动作。不支持的规则类型会拒绝该次更新并保留旧成功快照。

提供 [ACL4SSR 局域网规则](https://github.com/ACL4SSR/ACL4SSR/blob/master/Clash/LocalAreaNetwork.list)及 [ProxyLite](https://github.com/ACL4SSR/ACL4SSR/blob/master/Clash/ProxyLite.list) 的 URL 引用入口，不复制上游清单进本仓库。上游规则会变化，使用者需核对范围和许可证。blackmatrix7 部分 list 含 IP-ASN，当前不能完整导入；MetaCubeX 原生规则资源后续接入。

## 转换与客户端限制

协议与传输组合以上表为准。未知节点字段会被诊断并排除，避免转换时悄悄丢弃。解析失败显示诊断，零有效节点拒绝更新。

Clash legacy 会排除 VLESS/REALITY、Hysteria2、TUIC 和不支持的参数；严格模式遇到不兼容节点即拒绝生成。支持 Clash 风格配置不代表使用 legacy Clash 内核，mihomo 客户端请选择 mihomo 输出。

完整配置默认使用 loopback mixed 入口。TUN、透明代理、DNS 劫持与客户端入口需在实际客户端配置中处理；后续设备预设尚未实现。节点片段供 OpenWrt 插件等自行集成，不能当作所有客户端通用的完整订阅。配置结构校验与真实设备可用性是不同验收步骤。

Loon、Quantumult X、Surge、Stash 专用格式尚未实现。

当前 DNS 表单接受 IP 地址，过滤使用普通文字匹配。目标原生规则资源、设备 TUN 预设、任意字段覆盖、部分协议参数和真实设备验收仍在开发。服务只整理订阅，不安装 VPS、不转发代理流量，也不执行客户端控制。

## 验证方式

- Node 22.19 本地：类型检查、行为测试、前后端构建。
- Node 24 Linux arm64：Docker 构建时执行相同测试与构建。
- [mihomo v1.19.32](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.32)：使用官方镜像 `-t` 离线检查合成完整 YAML。
- [sing-box v1.14.2](https://github.com/SagerNet/sing-box/releases/tag/v1.14.2)：使用官方镜像 `check` 离线检查合成完整 JSON。
- Clash legacy：本地兼容过滤与输出结构测试；未运行旧官方内核。

`pnpm exec tsx scripts/kernel-fixtures.ts /tmp/subharbor-kernels` 生成不可连接的样例，CI 用固定内核版本并关闭网络检查。新增协议参数时应扩充样例与回归测试。GitHub Actions 文件已准备，未执行远程 CI，也未发布镜像。
