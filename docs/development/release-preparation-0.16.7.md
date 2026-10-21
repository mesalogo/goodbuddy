# Desktop 0.16.7 恢复发布准备

基于 `8939bfe1`，保留失败且未公开的 `v0.16.5`、`v0.16.6`，
已公开 Agent `0.15.7` 保持不变。

`v0.16.6` 的六平台内置 Python 验证及 Windows/Linux 打包成功。
Apple 拒绝两个 macOS 包：企业微信 wheel 中的 lxml 原生库未签名且缺少安全时间戳。
这不是外部网络错误，不复用失败标签。

macOS 自定义签名入口先处理安装包副本中 wheel 内的 Mach-O，
使用已有签名身份、钥匙串、安全时间戳和 hardened runtime，校验签名后
重新生成 wheel RECORD。随后调用 electron-builder 原有应用签名逻辑，
原有公证及 Gatekeeper 检查保持不变。上游锁、下载缓存和镜像字节不变。
纯 Python wheel 不重写，原生签名失败不覆盖原 wheel。

发布说明正文保持已批准内容，仅版本号变更；飞书/企业微信仍为预览版，
不构建 LoongArch。新增轮子签名回归测试；按用户要求由 CI 执行验证，
macOS 实际签名和公证必须在原生发布任务中通过。
