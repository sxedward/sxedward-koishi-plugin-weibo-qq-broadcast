# 更新日志

## 1.3.0 (2026-11-27)

- 控制台登录面板新增**短信验证码登录**：输入手机号获取验证码后填入即可登录，自动保存 Cookie（需 Puppeteer；会话内存保存，10 分钟有效）。
- 新增**微博网页截图**：开启 `screenshot` 后播报附带本地渲染的微博卡片截图，含作者、正文、超话来源、转发与图片；`screenshotWidth` 控制宽度，订阅项可单独覆盖。
- 安装 Puppeteer 的用途扩展为扫码登录、短信登录与截图三项。

## 1.2.0 (2026-11-26)

- 抓取接口默认切换为微博 PC 网页版 `ajax/statuses/mymblog`，新增 `apiMode`（pc / auto / mobile）配置。
- 支持播报**粉丝可见微博**：登录 Cookie 所属账号为博主粉丝时可拿到完整正文；非粉丝时识别占位卡片并跳过。
- 支持播报**超话帖子**：识别 `region_name`，在播报标题标注来源超话。
- 新增长微博全文展开（默认开启，`expandLongText` 可关闭）：移动端 `statuses/extend` 失败自动回退 PC 端 `statuses/longtext`。
- 归一化 PC / 移动端两套字段（`text_raw` / `raw_text`、`pic_infos` / `pics`），图片下载兼容两种来源。
- PC 接口请求携带 `x-xsrf-token`（从 Cookie 的 `XSRF-TOKEN` 提取），避免被判为未登录。

## 1.1.0 (2026-11-26)

- npm 包更名为作用域包 `@sxedward/koishi-plugin-weibo-qq-broadcast`，GitHub 仓库迁移至 `sxedward/sxedward-koishi-plugin-weibo-qq-broadcast`。
- 新增控制台扫码登录：在 Koishi 插件配置页通过 Puppeteer 打开微博登录页、提取二维码，扫码后自动保存 Cookie 到数据库。
- 新增 Cookie 状态实时显示：未登录 / 有效 / 已失效 / 检测失败，含账号昵称、UID、上次检测与更新时间。
- 新增 Cookie 失效自动通知：可通知订阅群/频道，并可额外私聊通知管理员，支持自定义文本与提醒冷却。
- 新增指令 `weiboqq.cookie`。

## 1.0.0

- 首次发布：面向 Koishi v4 QQ 官方机器人（`qq` / `qqguild`）的微博播报插件。
- 支持按平台名和 Bot ID 自动选择在线机器人，数据库保存每条订阅的最后微博 MID 去重。
- 支持图文推送、关键词白名单 / 屏蔽词黑名单、跳过转发、首次运行不推历史。
- 提供 `weiboqq.list` / `weiboqq.refresh` / `weiboqq.test` 调试指令。
