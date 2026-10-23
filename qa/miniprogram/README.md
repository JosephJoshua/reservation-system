# Mini program QA

Drives WeChat DevTools with `miniprogram-automator`. DevTools only runs on macOS and Windows,
so these scripts run on a developer machine, not in CI.

Setup once: install WeChat DevTools, sign in, and turn on 设置 → 安全设置 → 服务端口.

```sh
pnpm --filter @rs/qa-miniprogram smoke
```

Screenshots are written to `qa/miniprogram/screenshots/`. Set `WECHAT_DEVTOOLS_CLI` if DevTools
is not installed in the default location.
