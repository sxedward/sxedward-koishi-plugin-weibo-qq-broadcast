# @sxedward/koishi-plugin-weibo-qq-broadcast

微博动态播报插件，面向 Koishi v4 的 QQ 官方机器人适配器。

GitHub 仓库：https://github.com/sxedward/sxedward-koishi-plugin-weibo-qq-broadcast
问题反馈：https://github.com/sxedward/sxedward-koishi-plugin-weibo-qq-broadcast/issues · QQ 827679511

与常见的 OneBot 微博监控插件不同，本插件不写死 `onebot:QQ号`，而是按平台名和机器人 ID 自动选取 Koishi 中在线的官方 Bot，因此可以直接用于：

- `@koishijs/plugin-adapter-qq` 的 `qq` 平台：QQ 官方群机器人，目标 ID 是 `group_openid`，不是传统 QQ 群号。
- `@koishijs/plugin-adapter-qq` 的 `qqguild` 平台：QQ 频道机器人，目标 ID 是子频道 ID。

## 参考项目

实现思路参考了以下 GitHub 项目：

- `moehuhu/weibo-monitor`：使用微博移动端 AJAX 接口拉取最新微博并定时轮询。
- `YyyCoco/koishi-weibo-post-monitor`：订阅项结构与推送流程。
- `WhiteBr1ck/koishi-plugin-weibo-fetcher`：订阅配置、图文拆分、去重与调试设计。
- `MingxiaGuo/koishi-plugin-weibo-notify`：控制台扫码登录、二维码提取与 Cookie 保存流程。

## 功能

- 定时拉取指定微博用户的最新动态，推送到多个群或频道。
- 同时支持 `qq` 与 `qqguild`，可为每个订阅单独指定平台和机器人 ID。
- 默认使用微博 PC 网页版 ajax 接口，可播报**粉丝可见微博**和**超话帖子**；并会自动展开长微博全文。
- 使用数据库保存每个订阅的最后一条微博 MID，重启后不会重复推送。
- 支持文本、原微博链接、图片下载后发送，并可附加**微博网页截图**（渲染作者、正文、超话来源与图片）。
- 支持关键词白名单、屏蔽词黑名单、跳过转发微博。
- 在 Koishi 控制台的插件配置页登录微博，支持**扫码登录**和**短信验证码登录**，自动获取并保存 Cookie。
- 控制台实时显示 Cookie 状态：未登录 / 有效 / 已失效 / 检测失败，并显示账号昵称、UID、上次检测与更新时间。
- Cookie 失效时自动通知配置的群/频道，并可额外私聊通知管理员。
- 首次运行默认只记录最新微博，不推送历史内容，可通过配置开启。
- 提供 `weiboqq.cookie`、`weiboqq.refresh`、`weiboqq.test`、`weiboqq.list` 管理指令。

## 安装

1. 安装并启用 Koishi 官方 QQ 适配器：

   ```bash
   npm i @koishijs/plugin-adapter-qq
   ```

2. 确保已启用数据库服务，例如：

   ```bash
   npm i koishi-plugin-database-sqlite
   ```

3. 如需使用扫码登录、短信登录或微博网页截图，安装并启用 Puppeteer 服务：

   ```bash
   npm i koishi-plugin-puppeteer
   ```

4. 从 Koishi 市场安装本插件（或使用命令行）：

   ```bash
   koishi add sxedward/weibo-qq-broadcast
   ```

   安装后在 Koishi 控制台启用即可。本插件的控制台前端已预构建在 `dist/` 目录。若修改了 `client/` 下的源码，可运行：

   ```bash
   npm install
   npm run build:console
   ```

## 控制台扫码登录

启用插件后，打开 Koishi 控制台的「插件配置」，找到本插件。配置页顶部会出现「微博 Cookie 登录」面板：

1. 点击「扫码登录 / 刷新二维码」。
2. 插件会通过 Puppeteer 打开微博登录页，自动切换到扫码登录并提取二维码。
3. 使用微博 App 扫码并确认登录。
4. 登录成功后 Cookie 会自动保存到数据库，面板会显示账号昵称、UID 和 Cookie 状态「有效」。

面板按钮说明：

- `扫码登录 / 刷新二维码`：开始登录；登录中也可用它刷新二维码。
- `立即检查`：手动触发一次 Cookie 有效性检测。
- `清除 Cookie`：删除已保存的 Cookie。

Cookie 状态判断使用 `https://m.weibo.cn/api/config`，以 `data.login === true` 且存在用户信息为有效依据。检测不到有效登录态时显示「已失效」。

## 短信验证码登录

在控制台登录面板的「短信验证码登录」区域：

1. 输入手机号，点击「获取验证码」。
2. 插件会通过 Puppeteer 打开微博登录页，切到短信登录、填入手机号并请求验证码。
3. 收到短信后，在「短信验证码」输入框填入验证码，点击「登录」。
4. 登录成功后 Cookie 自动保存到数据库，面板显示当前账号昵称。

注意事项：

- 需要安装并启用 `koishi-plugin-puppeteer`。
- 短信登录会话只保存在内存中，默认 10 分钟内有效；超时需重新获取验证码。重新点击「获取验证码」会开启新会话。
- 未注册手机号验证通过后会由微博自动注册，请以微博平台实际规则为准。
- 手机号登录同样受微博风控影响；若请求频繁被拦截，可改用扫码登录。

## 微博网页截图

开启 `screenshot: true`（或在单个订阅里单独开启）后，每条播报会额外附带一张渲染好的微博卡片截图，包含作者、正文全文、超话来源、转发内容和图片。

- 截图由插件本地渲染 HTML 后生成，不依赖微博页面登录态，也不受微博风控影响。
- 需要安装并启用 `koishi-plugin-puppeteer`；未安装时会自动跳过截图，不影响文字和图片播报。
- `screenshotWidth` 控制截图宽度（默认 720 像素），高度按内容自适应。
- 截图与原图可能同时发送；若只想保留截图，可把 `sendImages` 设为 `false`。

## 超话帖子与粉丝可见微博

插件默认使用微博 PC 网页版的 `ajax/statuses/mymblog` 接口抓取（配置项 `apiMode: pc`）。相比旧的移动端接口，它能拿到受限博主的完整内容，是播报这两类微博的关键：

- **超话帖子**：微博用户在超话内发的帖子同样出现在其时间线里，带 `region_name` 字段。插件会识别该字段并在播报标题上标注 `超话：#超话名#`。超话帖子通常是长文本，插件会自动拉取全文。
- **粉丝可见微博**：前提条件是**扫码登录的微博账号必须是该博主的粉丝**。满足此条件时，PC 接口会返回完整正文并正常播报。若登录账号不是粉丝，微博只会返回「因用户隐私设置你看不到」的占位内容，插件会识别并跳过，不会播报错乱提示。
- **长文本展开**：时间线接口给的 `text` 会被截断，插件默认按 MID 调用全文接口补全正文（移动端 `statuses/extend` 失败会自动回退到 PC 端 `statuses/longtext`）。可通过 `expandLongText: false` 关闭。

如果没有通过控制台登录（或只手动填了不完整的 Cookie），PC 接口会返回 `ok=-100`，此时不会有任何播报。建议使用控制台扫码登录或短信登录，保证 Cookie 完整且包含 `XSRF-TOKEN`。

接口可用 `apiMode` 切换：

| 值 | 说明 |
| --- | --- |
| `pc` | 默认值。仅用 PC 接口，能播报粉丝可见与超话长文，需要登录 Cookie。 |
| `auto` | 先试 PC 接口，失败时自动回退到旧移动端接口。 |
| `mobile` | 仅用旧移动端接口，不需要登录，但看不到粉丝可见微博和长文全文。 |

## 配置示例

```yaml
plugins:
  weibo-qq-broadcast:
    cookie: ''
    platform: qq
    selfId: ''
    updateInterval: 5
    apiMode: pc
    expandLongText: true
    screenshot: false
    screenshotWidth: 720
    cookieCheckInterval: 30
    expiryNotify: true
    expiryNotifyChannels: []
    adminUsers: []
    expiryNoticeText: ''
    expiryNotifyCooldown: 720
    pushOnFirstPoll: false
    showLink: true
    sendImages: true
    maxImages: 4
    mentionAll: false
    debug: false
    subscriptions:
      - uid: '2803301701'
        name: 人民日报
        channels:
          - 'YOUR_GROUP_OPENID'
        platform: qq
        keywords: []
        blockwords: []
        skipForward: false
```

如果要推送到 QQ 频道，把 `platform` 改为 `qqguild`，`channels` 填子频道 ID。也可以在单个订阅里覆盖全局 `platform` 和 `selfId`，实现多个机器人、多个平台混合推送。

## 配置项说明

| 配置项 | 说明 |
| --- | --- |
| `cookie` | 手动 Cookie，可选。留空则使用控制台扫码登录保存的 Cookie；填写后手动 Cookie 优先。 |
| `platform` | 默认平台，`qq` 或 `qqguild`。 |
| `selfId` | 默认机器人 ID。留空则自动选择该平台下第一个在线 Bot。 |
| `updateInterval` | 轮询间隔，单位分钟，范围 1 到 1440。 |
| `apiMode` | 抓取接口：`pc`（默认，支持粉丝可见/超话长文，需登录）、`auto`（PC 失败回退移动端）、`mobile`（旧移动端接口）。 |
| `expandLongText` | 是否自动展开长微博全文，默认开启。 |
| `screenshot` | 播报时是否附加微博网页截图，默认关闭；需 Puppeteer。 |
| `screenshotWidth` | 网页截图宽度（像素），默认 720，高度自适应。 |
| `cookieCheckInterval` | Cookie 有效性检查间隔，单位分钟。 |
| `expiryNotify` | Cookie 失效时是否发送通知。 |
| `expiryNotifyChannels` | 失效通知目标。留空则通知所有订阅的群/频道。 |
| `adminUsers` | 额外私聊通知的用户 ID / openid 列表。 |
| `expiryNoticeText` | 自定义失效通知文本。 |
| `expiryNotifyCooldown` | Cookie 持续失效时重复提醒的最小间隔，单位分钟。 |
| `pushOnFirstPoll` | 首次运行或新增订阅时是否推送当前最新微博。默认关闭。 |
| `showLink` | 是否在文本末尾附上 `m.weibo.cn` 原微博链接。 |
| `sendImages` | 是否下载并发送图片。 |
| `maxImages` | 每条微博最多发送几张图片，范围 0 到 9。 |
| `mentionAll` | 是否 @全体成员。仅 `qqguild` 会生成真正的 @；`qq` 官方群会降级为纯文本提示。 |
| `subscriptions` | 订阅列表。每项包含 `uid`、`channels`、`platform`、`selfId`、关键词、屏蔽词等。 |

## 指令

| 指令 | 权限 | 说明 |
| --- | --- | --- |
| `weiboqq.cookie` | 2 | 检查并播报当前 Cookie 状态。 |
| `weiboqq.list` | 1 | 查看当前订阅列表。 |
| `weiboqq.refresh` | 2 | 立即按正常去重逻辑检查一次更新。 |
| `weiboqq.test` | 2 | 强制把每个订阅的最新一条微博推送到目标，用于调试，不改变去重状态。 |

## QQ 官方机器人注意事项

- QQ 官方群机器人使用的是 `group_openid`，不是 QQ 群号。可从机器人收到群消息时的事件中获取。
- QQ 官方机器人发送主动消息受官方平台规则和频率限制约束。推送失败时请查看 Koishi 控制台日志，确认是否被平台限流。
- 微博接口属于非官方公开接口，字段和访问策略可能变化。出现 `ok != 1`、418 或内容为空时，可尝试重新扫码登录或增大轮询间隔。
- 扫码登录依赖 Puppeteer。服务器无图形环境也可使用，二维码会直接显示在 Koishi 控制台。
- Cookie 和登录态属于敏感信息，仅保存在 Koishi 数据库中，请勿把导出的数据库或配置提交到公开仓库。
- 本插件仅供学习和个人使用，请遵守微博和 QQ 平台的相关协议，控制轮询频率。

## 许可证

MIT
