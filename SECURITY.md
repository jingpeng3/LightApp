# 安全说明

## 适用场景

dt 面向**本机单人**使用：

- 服务只监听 `127.0.0.1`，没有登录和鉴权。本机上任何进程都能读写数据。
- HTTP 请求校验 Host 头（防 DNS rebinding），WebSocket 只接受本机 Origin。
- 不要把 dt 服务暴露到局域网或公网，也不要放在反向代理后面对外提供。

## 需要注意的能力

- **`command` 绑定**会以 `dt serve` 进程的身份执行 shell 命令。只配置你信任的命令；agent 创建这类绑定前应先征得人的确认。
- **`webhook` 绑定**会把记录内容发到配置的 URL。不要把敏感数据发到不受你控制的地址；需要校验来源时配置 `secret`，接收方验证 `X-DT-Signature`。
- **附件**只引用本机路径，不复制文件。文件读取接口只返回附件字段里登记过的路径，目录附件禁止 `..` 和符号链接越界；响应带 `Content-Security-Policy: sandbox`，HTML/SVG 附件里的脚本不会以本站身份执行。

## 报告漏洞

请不要公开提 issue。通过 GitHub 的 [Security Advisories](../../security/advisories/new) 私下报告，说明影响范围和复现步骤。我们会尽快确认并修复。
