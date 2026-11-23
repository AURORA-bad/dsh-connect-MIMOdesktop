# dsh-connect-MIMOdesktop

把小米 MiMo 桌面 App 已登录的模型接进 DeepSeek Harness，并在设置页提供账号池、模型开关与连通性诊断。复用桌面端登录态，不需要单独申请 API Key，也没有常驻进程。

## 为什么有这个项目

本来想开一年 token play，手滑开成了 MiMo 桌面端订阅。钱花出去了，接口却不是给第三方用的：桌面 App 能聊，DSH 里选不到。

社区里原本有类似工具，但已经停耕，跟不上现在的网关。于是参照那些开源项目的做法，重新写了一个：直接复用桌面端已经登录的凭证，把订阅额度接进 DSH。

**只为本机自用而写，不保证适配你的环境。** 网关是私有接口，小米随时可以改；改了就修。

## 安装

```bash
# 在 DSH profile 目录（~/.dsh/profiles/desktop）
git clone https://github.com/AURORA-bad/dsh-connect-MIMOdesktop.git
pnpm add link:./dsh-connect-MIMOdesktop
# 该 profile 用 pnpm；npm install link: 会报 EUNSUPPORTEDPROTOCOL
```

装完重启 DSH。**不要和 `dsh-mimo-connect` 同时启用**：两者都注册 provider `mimo`，会重复。

## 三处界面

| 位置 | 内容 |
| --- | --- |
| 输入框右侧胶囊 | 额度剩余百分比，只在会话切到 MiMo 时出现 |
| 设置 → MiMo | 账号池、模型开关、总开关、诊断 |
| 左侧导航（可选） | 打开同一张设置页 |

## 设置项

- `providerEnabled` — 关掉后不再注册提供方、不再轮询；页面保留以便重新打开。
- `showQuotaInComposer` — 是否显示额度胶囊（位置由 `quotaPlacement` 决定）。
- `quotaPlacement` — 额度显示位置：`input`（输入框内、模型选择器前）或 `dock`（输入框下方统计行），默认 `dock`。
- `sidebarPanel` — 是否在左侧导航加一行。
- `pollIntervalMs` — 额度刷新间隔（1/5/10/30/60 分钟）。
- `enabledModels` — 勾选的模型才进模型选择器；`null` 表示全部。

## 账号池

MiMo 没有账号清单接口，所以这里是**本地名册**（`$DSH_HOME/.mimo-connect-pool.json`，仅本人可读，passToken 以掩码形式回显）：

- 空池 → 回落到 `credential.js` 的单份凭证（插件自己的文件或桌面端登录态），老装法不受影响；
- 某个账号被网关拒绝（401/403）→ 冷却 5 分钟并切到下一个；
- HTTP 400 不算凭证问题，不轮换；
- 全部冷却 → 仍用当前账号硬试一次，冷却只是提示不是判决。

## 诊断

`测试连通性` 用选中的模型发一条 `max_tokens: 1` 的真实请求，回状态码与耗时。60 秒超时。

## 与 dsh-connect-workbuddy 的差异（做不到的部分）

MiMo 网关实测只确认两个接口：

- `GET /api/user/usage` — `percent` + `resetDate`/`resetAt`
- `POST /api/route/chat/completions` — 对话

模型清单 `/api/route/models`、`/api/route/model/list`、`/api/models` 全部 404；积分余额、签到、福利领取、负载繁忙度、排队位次接口全部 404 或 401。

因此 workbuddy 里依赖这些上游数据的板块在 MiMo 侧**没有数据源**，已用等价物替代：

| workbuddy | 这里 |
| --- | --- |
| 积分余额 / 活动徽标 | 额度百分比（`/api/user/usage`）+ 内置倍率显示 |
| 按积分排序账号池 | 本地账号池 + 冷却轮换 |
| 繁忙小人 / 排队位次 | 无替代（无上游数据） |
| 每日签到 / 福利领取 | 无替代（接口不存在） |
| 25k token 压力测试 | 单 token 连通性探针 |

## 开发

```bash
npm run build   # src/client.js → lib/client.js（拷贝 + sourcemap 行，无打包器）
npm test        # 14 项断言：设置归一化、掩码、账号池轮换
```

`tests/run.mjs` 里的入口 smoke 在没装宿主的检出里会 skip（`@deepseek-ai/*` 解析不到），装进 profile 后才会真正跑。

## 致谢

接口形状与若干踩坑结论参考了这些项目的公开代码与文档：

- [dsh-connect-workbuddy](https://github.com/) 系列 —— 设置页布局、账号池与诊断面板的结构来源
- 已停耕的 MiMo 第三方桥接工具 —— STS 换票链路与 cookie 分域规则

没有它们就没有这份实现。本项目与上述项目、与小米公司均无关联。

## 免责

- 使用的是桌面端**你自己的**登录态，不绕过任何付费环节；额度仍由你的订阅承担。
- 网关为未公开接口，随时可能变更或封禁。使用风险自负。
- 请勿用于分发凭证、共享账号或任何违反小米服务条款的用途。

## License

MIT
