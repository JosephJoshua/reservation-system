# Mini program QA

Drives WeChat DevTools with `miniprogram-automator`. DevTools only runs on macOS and Windows,
so these scripts run on a developer machine, not in CI.

Setup once: install WeChat DevTools, sign in, and turn on 设置 → 安全设置 → 服务端口.

DevTools will not open the placeholder AppID in `project.config.json`. Pass a real AppID, or a
test AppID from https://developers.weixin.qq.com/sandbox, through `WX_APPID`. The build writes it
to the gitignored `project.private.config.json`.

```sh
WX_APPID=wx0123456789abcdef pnpm --filter @rs/qa-miniprogram smoke
```

Screenshots are written to `qa/miniprogram/screenshots/`. Set `WECHAT_DEVTOOLS_CLI` if DevTools
is not installed in the default location.
