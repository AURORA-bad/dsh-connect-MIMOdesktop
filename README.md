# dsh-connect-mimo

把小米 MiMo 桌面 App 里已经登录的模型接进 DeepSeek Harness。

不用单独申请 API Key，也没有常驻进程——插件读桌面端的登录态，替你去调网关。

## 起因

本来想开一年 token play，手滑开成了 MiMo 桌面端订阅。

钱花出去了，接口却不是给第三方用的：桌面 App 里能聊，DSH 里选不到这个模型。社区早先有类似工具，但都停更了，跟不上现在的网关。于是照着那些项目的思路重写了一份。

**Windows 桌面端实测，其他平台未验证。** 网关是私有接口，小米随时能改，改了就修。

## 安装

```bash
dsh plugin --profile web add github:AURORA-bad/dsh-connect-MIMOdesktop
```

装完重启 DSH。需要 Node `^22.19.0 || >=24.0.0`。

发布到 npm 之后也可以直接 `dsh plugin --profile web add dsh-connect-mimo`。

想在本地改代码再装，走 clone + link（这个 profile 用 pnpm，`npm install link:...` 会报 `EUNSUPPORTEDPROTOCOL`）：

```bash
cd ~/.dsh/profiles/desktop
git clone https://github.com/AURORA-bad/dsh-connect-MIMOdesktop.git
pnpm add link:./dsh-connect-MIMOdesktop
```

## 界面

| 位置 | 内容 |
| --- | --- |
| 输入框右侧胶囊 | 额度剩余百分比，只在当前会话切到 MiMo 时出现 |
| 设置 → MiMo | 账号池、模型开关、总开关、诊断 |
| 左侧导航（可选） | 打开同一张设置页 |

「测试连通性」用你选中的模型发一条 `max_tokens: 1` 的真实请求，回状态码和耗时，60 秒超时。

## 设置项

- `providerEnabled` — 关掉之后不再注册提供方、不再轮询；页面留着，方便重新打开。
- `showQuotaInComposer` — 要不要显示额度胶囊。
- `quotaPlacement` — 胶囊放哪：`input` 放输入框里、模型选择器前面，`dock` 放输入框下方的统计行。默认 `dock`。
- `sidebarPanel` — 要不要在左侧导航加一行。
- `pollIntervalMs` — 额度刷新间隔，1/5/10/30/60 分钟可选。
- `enabledModels` — 勾上的模型才进模型选择器。`null` 表示全都要。

## 账号池

MiMo 没有账号清单接口，所以这里是个**本地名册**，存在 `$DSH_HOME/.mimo-connect-pool.json`，只有本人可读，passToken 回显时打码。

- 池子是空的 → 退回单份凭证（插件自己存的，或桌面端登录态），老装法不受影响。
- 某个账号被网关拒了（401/403）→ 冷却 5 分钟，切下一个。
- HTTP 400 不算凭证问题，不轮换。
- 全都在冷却 → 还是拿当前账号硬试一次。冷却只是提示，不是判决。

## 命令行

桌面端没登录、或者不想开着 DSH 排查问题时用：

```bash
dsh-connect-mimo status [--json]   # 看凭证解析到哪一步，不联网
dsh-connect-mimo login             # 不依赖桌面端，单独登录插件
dsh-connect-mimo logout            # 删掉插件自己存的凭证
dsh-connect-mimo verify            # 建会话，真实调一次模型
dsh-connect-mimo doctor            # 本地诊断，逐条列出凭证候选路径的判定
```

`login` 做不到一键自动登录。`passToken` 是 HttpOnly 的，脚本拿不到；小米 passport 也不接受第三方回调，会直接回 `Callback连接不合法`。所以它只能一步步告诉你该去浏览器 cookie 面板复制哪三个值。

桌面端已经登录的话，完全用不上它。

凭证来源的优先级：插件自己的 `.mimo-connect-auth.json` 优先，没有才去读桌面端 cookie（只读）。

## 开发

```bash
npm run build   # src/client.js → lib/client.js（拷贝 + sourcemap 行，没有打包器）
npm test        # 设置归一化、掩码、账号池轮换与冷却持久化
```

`tests/run.mjs` 里的入口 smoke 在没装宿主的检出里会 skip——`@deepseek-ai/*` 解析不到。装进 profile 之后才会真跑。

CI（`.github/workflows/ci.yml`）在 Linux/Windows × Node 22/24 上跑同一个脚本，并校验 `lib/client.js` 与 `src/client.js` 同步——改完 `src/client.js` 忘了 `npm run build` 会直接红。本地想先跑一遍：

```sh
node tests/run.mjs
node tools/build-client.mjs && git diff --exit-code lib/client.js
```

## 致谢

接口形状和若干踩坑结论来自社区里已有的开源实现。这些项目给了方向，代码是重写的。

本项目与它们、与小米公司都没有关联。

## 免责

- 用的是桌面端**你自己的**登录态，不绕过任何付费环节，额度还是你的订阅在承担。
- 网关是未公开接口，随时可能变更或封禁。风险自负。
- 别拿它分发凭证、共享账号，或做任何违反小米服务条款的事。

## License

MIT
