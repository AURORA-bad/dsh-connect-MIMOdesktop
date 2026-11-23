# dsh-connect-MIMOdesktop

把小米 MiMo 桌面 App 里已经登录的模型接进 DeepSeek Harness。

不用单独申请 API Key，也没有常驻进程——插件读桌面端的登录态，替你去调网关。

## 起因

本来想开一年 token play，手滑开成了 MiMo 桌面端订阅。

钱花出去了，接口却不是给第三方用的：桌面 App 里能聊，DSH 里选不到这个模型。社区早先有类似工具，但都停更了，跟不上现在的网关。于是照着那些项目的思路重写了一份。

**只为本机自用写的，不保证适配你的环境。** 网关是私有接口，小米随时能改，改了就修。

## 安装

在 DSH 的 profile 目录（一般是 `~/.dsh/profiles/desktop`）里：

```bash
git clone https://github.com/AURORA-bad/dsh-connect-MIMOdesktop.git
pnpm add link:./dsh-connect-MIMOdesktop
```

这个 profile 用的是 pnpm。换成 `npm install link:...` 会报 `EUNSUPPORTEDPROTOCOL`。

装完重启 DSH。

需要 Node `^22.19.0 || >=24.0.0`。

## 命令行

桌面端没登录、或者不想开着 DSH 排查问题时用：

```bash
dsh-connect-MIMOdesktop status [--json]   # 看凭证解析到哪一步，不联网
dsh-connect-MIMOdesktop login             # 不依赖桌面端，单独登录插件
dsh-connect-MIMOdesktop logout            # 删掉插件自己存的凭证
dsh-connect-MIMOdesktop verify            # 建会话，真实调一次模型
dsh-connect-MIMOdesktop doctor            # 本地诊断
```

`login` 做不到一键自动登录。`passToken` 是 HttpOnly 的，脚本拿不到；小米 passport 也不接受第三方回调，会直接回 `Callback连接不合法`。所以它只能一步步告诉你该去浏览器 cookie 面板复制哪三个值。

桌面端已经登录的话，完全用不上它。

凭证来源的优先级：插件自己的 `.mimo-connect-auth.json` 优先，没有才去读桌面端 cookie（只读）。

## 界面上能看到的三处

| 位置 | 内容 |
| --- | --- |
| 输入框右侧胶囊 | 额度剩余百分比，只在当前会话切到 MiMo 时出现 |
| 设置 → MiMo | 账号池、模型开关、总开关、诊断 |
| 左侧导航（可选） | 打开同一张设置页 |

## 设置项

- `providerEnabled` — 关掉之后不再注册提供方、不再轮询；页面留着，方便重新打开。
- `showQuotaInComposer` — 要不要显示额度胶囊。
- `quotaPlacement` — 胶囊放哪：`input` 放输入框里、模型选择器前面，`dock` 放输入框下方的统计行。默认 `dock`。
- `sidebarPanel` — 要不要在左侧导航加一行。
- `pollIntervalMs` — 额度刷新间隔，1/5/10/30/60 分钟可选。
- `enabledModels` — 勾上的模型才进模型选择器。`null` 表示全都要。

## 账号池

MiMo 没有提供账号清单接口，所以这里是个**本地名册**，存在 `$DSH_HOME/.mimo-connect-pool.json`，只有本人可读，passToken 回显时打码。

- 池子是空的 → 退回单份凭证（插件自己存的，或桌面端登录态），老装法不受影响。
- 某个账号被网关拒了（401/403）→ 冷却 5 分钟，切下一个。
- HTTP 400 不算凭证问题，不轮换。
- 全都在冷却 → 还是拿当前账号硬试一次。冷却只是提示，不是判决。

## 诊断

「测试连通性」用你选中的模型发一条 `max_tokens: 1` 的真实请求，回状态码和耗时。60 秒超时。

## 和 dsh-connect-workbuddy 比，少了什么

MiMo 网关实测只确认了两个接口：

- `GET /api/user/usage` — 给 `percent` 和 `resetDate`/`resetAt`
- `POST /api/route/chat/completions` — 对话

模型清单试过 `/api/route/models`、`/api/route/model/list`、`/api/models`，全部 404。积分余额、签到、福利领取、负载繁忙度、排队位次，同样全部 404 或 401。

workbuddy 里依赖这些上游数据的板块，在 MiMo 这边没有数据源，只能用等价物顶着：

| workbuddy | 这里 |
| --- | --- |
| 积分余额 / 活动徽标 | 额度百分比（`/api/user/usage`）+ 内置倍率显示 |
| 按积分排序账号池 | 本地账号池 + 冷却轮换 |
| 繁忙小人 / 排队位次 | 没有替代，上游没数据 |
| 每日签到 / 福利领取 | 没有替代，接口不存在 |
| 25k token 压力测试 | 单 token 连通性探针 |

## 开发

```bash
npm run build   # src/client.js → lib/client.js（拷贝 + sourcemap 行，没有打包器）
npm test        # 14 项断言：设置归一化、掩码、账号池轮换
```

`tests/run.mjs` 里的入口 smoke 在没装宿主的检出里会 skip——`@deepseek-ai/*` 解析不到。装进 profile 之后才会真跑。

## 致谢

接口形状和若干踩坑结论来自社区里已有的开源实现：

- **dsh-connect-workbuddy** 系列 —— 设置页布局、账号池和诊断面板的结构来源
- **已停耕的 MiMo 第三方桥接工具** —— STS 换票链路和 cookie 分域规则

这些项目给了方向，代码是重写的。本项目与它们、与小米公司都没有关联。

## 免责

- 用的是桌面端**你自己的**登录态，不绕过任何付费环节，额度还是你的订阅在承担。
- 网关是未公开接口，随时可能变更或封禁。风险自负。
- 别拿它分发凭证、共享账号，或做任何违反小米服务条款的事。

## License

MIT
