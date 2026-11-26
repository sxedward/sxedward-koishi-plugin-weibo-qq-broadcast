'use strict'

// koishi-plugin-weibo-qq-broadcast
// 参考实现：
// - moehuhu/weibo-monitor：m.weibo.cn 移动端 AJAX 拉取 + 定时轮询思路
// - YyyCoco/koishi-weibo-post-monitor：订阅项与推送流程
// - WhiteBr1ck/koishi-plugin-weibo-fetcher：订阅配置、图文拆分、去重与调试思路
// - MingxiaGuo/koishi-plugin-weibo-notify：控制台扫码登录、二维码提取与 Cookie 保存流程
//
// 与 OneBot 插件的关键区别：
// - 不写死 onebot:<QQ号>，而是按 platform / selfId 自动挑选 Koishi 中在线的 QQ 官方 Bot
// - 同时支持 qq（QQ 群，目标是 group_openid）和 qqguild（QQ 频道，目标是频道 ID）
// - Cookie 可在 Koishi 控制台插件配置页扫码登录后自动获取，并保存到数据库
// - 使用数据库保存每个订阅的 last mid，避免重启后重复推送

const path = require('node:path')
const { Logger, Schema, h, sleep } = require('koishi')

const name = 'weibo-qq-broadcast'
const logger = new Logger(name)

const LOGIN_SCHEMA_ROLE = 'weibo-qq-broadcast-login'
const API_PREFIX = '/weibo-qq-broadcast/api'
const LOGIN_URL = 'https://passport.weibo.com/'
const WEIBO_CONFIG_API = 'https://m.weibo.cn/api/config'
const WEIBO_CONTAINER_API = 'https://m.weibo.cn/api/container/getIndex'
// PC 端 ajax 接口：带完整 Cookie 才能看到「仅粉丝可见」等受限微博，字段也更全（text_raw / pic_infos / region_name）
const WEIBO_PC_API = 'https://www.weibo.com/ajax/statuses/mymblog'
// 长文本展开接口：时间线里的 text 会被截断，需按 mid 拉取完整正文
const WEIBO_EXTEND_API = 'https://m.weibo.cn/statuses/extend'
const WEIBO_LONGTEXT_API = 'https://www.weibo.com/ajax/statuses/longtext'
const COOKIE_TABLE = 'weibo_qq_broadcast_cookie'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

module.exports.name = name
module.exports.inject = {
  required: ['http', 'database'],
  optional: ['console', 'server', 'puppeteer'],
}

const LoginPanel = Schema.object({}).role(LOGIN_SCHEMA_ROLE).description('微博 Cookie 登录')

const ConfigBody = Schema.object({
  cookie: Schema.string()
    .role('textarea')
    .default('')
    .description('手动 Cookie（可选）。留空则使用控制台扫码登录保存的 Cookie；填写后手动 Cookie 优先。'),

  platform: Schema.union(['qq', 'qqguild'])
    .default('qq')
    .description('默认推送平台。qq = QQ 官方群机器人（填 group_openid）；qqguild = QQ 频道机器人（填频道 ID）。'),

  selfId: Schema.string()
    .default('')
    .description('默认机器人 ID。留空则自动选择该平台下第一个在线 Bot。'),

  updateInterval: Schema.number()
    .min(1)
    .max(1440)
    .default(5)
    .description('轮询间隔，单位：分钟。'),

  apiMode: Schema.union(['pc', 'mobile', 'auto'])
    .default('pc')
    .description('微博接口：pc = PC 网页 ajax 接口（推荐，需登录 Cookie，可播报粉丝可见微博与超话长文）；mobile = 旧移动端接口；auto = 先 PC 失败再回退移动端。'),

  expandLongText: Schema.boolean()
    .default(true)
    .description('自动展开长微博全文（超话长文常见）。关闭则只播报时间线里的截断文本。'),

  cookieCheckInterval: Schema.number()
    .min(1)
    .max(1440)
    .default(30)
    .description('Cookie 有效性检查间隔，单位：分钟。'),

  expiryNotify: Schema.boolean()
    .default(true)
    .description('Cookie 失效时是否发送通知。'),

  expiryNotifyChannels: Schema.array(Schema.string())
    .default([])
    .description('Cookie 失效通知目标。留空则通知所有订阅的频道/群。'),

  adminUsers: Schema.array(Schema.string())
    .default([])
    .description('Cookie 失效时额外私聊通知的用户 ID / openid 列表。'),

  expiryNoticeText: Schema.string()
    .role('textarea')
    .default('')
    .description('自定义失效通知文本。留空则使用内置文本。'),

  expiryNotifyCooldown: Schema.number()
    .min(1)
    .max(10080)
    .default(720)
    .description('Cookie 持续失效时重复提醒的最小间隔，单位：分钟。'),

  pushOnFirstPoll: Schema.boolean()
    .default(false)
    .description('首次运行或新增订阅时是否推送当前最新微博。默认只记录，不推送，避免刷屏。'),

  showLink: Schema.boolean()
    .default(true)
    .description('是否在文本末尾附上原微博链接。'),

  sendImages: Schema.boolean()
    .default(true)
    .description('是否下载并发送微博图片。'),

  maxImages: Schema.natural()
    .min(0)
    .max(9)
    .default(4)
    .description('单条微博最多发送几张图片。'),

  mentionAll: Schema.boolean()
    .default(false)
    .description('是否 @全体成员。仅 qqguild 平台会真正 @；qq 官方群会降级为纯文本提示。'),

  debug: Schema.boolean()
    .default(false)
    .description('是否输出详细调试日志。'),

  subscriptions: Schema.array(Schema.object({
    uid: Schema.string()
      .required()
      .description('微博用户 UID，即 weibo.com/u/ 后面的数字。'),

    name: Schema.string()
      .default('')
      .description('备注名，仅用于日志和列表显示。'),

    channels: Schema.array(Schema.string())
      .role('table')
      .description('接收推送的目标列表。qq 平台填 group_openid，qqguild 平台填频道 ID。'),

    platform: Schema.union(['qq', 'qqguild'])
      .default('qq')
      .description('该订阅使用的平台，覆盖全局设置。'),

    selfId: Schema.string()
      .default('')
      .description('该订阅使用的机器人 ID，留空则用全局设置或自动选择。'),

    keywords: Schema.array(Schema.string())
      .default([])
      .description('关键词白名单。留空表示不按关键词过滤。'),

    blockwords: Schema.array(Schema.string())
      .default([])
      .description('屏蔽词黑名单，命中则不推送。'),

    skipForward: Schema.boolean()
      .default(false)
      .description('是否跳过转发微博。'),

    showLink: Schema.boolean()
      .default(true)
      .description('覆盖全局：是否附带原微博链接。'),

    sendImages: Schema.boolean()
      .default(true)
      .description('覆盖全局：是否发送图片。'),

    maxImages: Schema.natural()
      .min(0)
      .max(9)
      .default(4)
      .description('覆盖全局：最多发送几张图片。'),

    mentionAll: Schema.boolean()
      .default(false)
      .description('覆盖全局：是否 @全体成员。'),
  }).description('订阅项')).role('table').description('微博订阅列表'),
}).description('播报设置')

module.exports.Config = Schema.intersect([
  LoginPanel,
  ConfigBody,
]).description('微博播报（QQ 官方机器人）配置')

function getCookie(config, state) {
  return String(config.cookie || '').trim() || String(state.cookie || '').trim()
}

function extractXsrfToken(payload) {
  if (!payload) return ''
  if (Array.isArray(payload)) {
    const token = payload.find((item) => item?.name === 'XSRF-TOKEN' || item?.name === 'XSRF')
    return String(token?.value || '')
  }
  const match = String(payload).match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/i)
  return match ? decodeURIComponent(match[1]) : ''
}

function buildHeaders(config, state, referer, options = {}) {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: referer || 'https://m.weibo.cn/',
    'User-Agent': UA,
  }
  if (options.mobile) headers['mweibo-pwa'] = '1'
  if (options.xhr) headers['X-Requested-With'] = 'XMLHttpRequest'

  const cookie = getCookie(config, state)
  if (cookie) {
    headers.Cookie = cookie
    // PC ajax 接口要求 XSRF token，否则可能被判为未登录（ok=-100）
    // 扫码保存的 cookie 对象里带 XSRF-TOKEN；手动填写的整串 Cookie 里也可能含它
    const xsrf = extractXsrfToken(options.mobile || options.xhr ? state.cookies : null) || extractXsrfToken(cookie)
    if (xsrf) headers['x-xsrf-token'] = xsrf
  }
  return headers
}

// 把 PC / 移动端两套字段归一化到统一结构，方便后续处理
function normalizePost(raw, source) {
  if (!raw || typeof raw !== 'object') return null
  const mid = getMid(raw)
  if (!mid) return null

  const user = raw.user || {}
  const regionName = String(raw.region_name || raw.regionName || '').trim()
  // PC 用 text_raw，移动端用 raw_text；两者都缺失时再退回 HTML 的 text
  const fullText = String(source === 'pc'
    ? (raw.text_raw ?? raw.text ?? '')
    : (raw.raw_text ?? raw.text ?? ''))
  const text = fullText.trim() || stripHtml(raw.text ?? '')
  const isLong = raw.isLongText === true || raw.isLongText === 1 || /全文|展开/.test(String(raw.text || ''))

  return {
    mid,
    source,
    raw,
    user,
    author: String(user.screen_name || user.name || '微博用户').trim(),
    text,
    isLong,
    regionName,
    visible: raw.visible || null,
    createdAt: String(raw.created_at || ''),
    retweeted: raw.retweeted_status ? normalizePost(raw.retweeted_status, source) : null,
    picIds: Array.isArray(raw.pic_ids) ? raw.pic_ids.map(String) : [],
    picInfos: raw.pic_infos || {},
    pics: Array.isArray(raw.pics) ? raw.pics : [],
  }
}

// m.weibo.cn 时间线在未登录/非粉丝时，会把受限微博替换成占位卡片，必须过滤掉
function isPlaceholderPost(post) {
  if (!post) return true
  const text = String(post.text || '')
  const user = post.user || {}
  const hasAuthor = Boolean(user.id ?? user.idstr ?? user.screen_name)
  if (!post.picIds.length && !post.pics.length && !Object.keys(post.picInfos).length && !hasAuthor) return true
  // 只匹配微博系统生成的完整提示句式，避免把正文里提到「粉丝可见」的正常微博误判为占位
  return [
    '因用户隐私设置，你看不到这条微博',
    '由于用户隐私设置，你看不到这条微博',
    '你当前无法查看这条微博',
    '该微博因用户设置为仅粉丝可见',
    '这条微博仅粉丝可见',
    '该微博已被作者删除',
    '很抱歉，你看不到这条微博',
  ].some((marker) => text.includes(marker))
}

async function expandLongText(ctx, config, state, post) {
  if (!config.expandLongText || !post.isLong) return post.text

  // 先试移动端 extend，再试 PC longtext；两者取先成功的完整正文
  const attempts = [
    {
      url: WEIBO_EXTEND_API,
      headers: buildHeaders(config, state, `https://m.weibo.cn/status/${post.mid}`, { mobile: true, xhr: true }),
      pick: (payload) => payload?.data?.longTextContent,
    },
    {
      url: WEIBO_LONGTEXT_API,
      headers: buildHeaders(config, state, `https://weibo.com/${post.user?.id ?? ''}/${post.mid}`, { xhr: true }),
      pick: (payload) => payload?.data?.longTextContent || payload?.longTextContent,
    },
  ]

  for (const attempt of attempts) {
    try {
      const response = await ctx.http(attempt.url, {
        method: 'GET',
        params: { id: post.mid },
        headers: attempt.headers,
        responseType: 'json',
        timeout: 15000,
      })
      const payload = parseLooseJson(response.data)
      const html = attempt.pick(payload)
      if (html) {
        const expanded = stripHtml(html)
        if (expanded) return expanded
      }
    } catch (error) {
      if (config.debug) logger.info(`展开长文本失败（${post.mid}，${attempt.url}）：${error.message}`)
    }
  }
  return post.text
}

async function fetchPcPosts(ctx, config, state, uid) {
  if (!getCookie(config, state)) {
    throw new Error('PC 接口需要登录 Cookie，请先在插件配置页扫码登录')
  }
  const response = await ctx.http(WEIBO_PC_API, {
    method: 'GET',
    params: { uid, page: 1, feature: 0 },
    headers: buildHeaders(config, state, `https://weibo.com/u/${uid}`, { xhr: true }),
    responseType: 'json',
    timeout: 20000,
  })
  const payload = parseLooseJson(response.data)
  if (payload.ok !== 1) {
    throw new Error(`PC 微博接口返回异常：ok=${payload.ok ?? 'unknown'}${payload.msg ? ` msg=${payload.msg}` : ''}`)
  }
  const list = payload.data?.list
  if (!Array.isArray(list)) return []
  return list.map((item) => normalizePost(item, 'pc')).filter(Boolean)
}

async function fetchMobilePosts(ctx, config, state, uid) {
  const response = await ctx.http(WEIBO_CONTAINER_API, {
    method: 'GET',
    params: {
      type: 'uid',
      value: uid,
      containerid: `107603${uid}`,
    },
    headers: buildHeaders(config, state, `https://weibo.com/u/${uid}`, { mobile: true, xhr: true }),
    responseType: 'json',
    timeout: 20000,
  })

  const payload = parseLooseJson(response.data)
  if (payload.ok !== 1) {
    throw new Error(`微博接口返回异常：ok=${payload.ok ?? 'unknown'}`)
  }

  const cards = payload.data?.cards
  if (!Array.isArray(cards)) return []
  return cards
    .map((card) => normalizePost(card?.mblog, 'mobile'))
    .filter(Boolean)
}

function parseLooseJson(payload) {
  if (payload && typeof payload === 'object') return payload
  const text = String(payload ?? '')
  const start = text.indexOf('{')
  if (start < 0) throw new Error('微博接口响应中未找到 JSON 数据')
  return JSON.parse(text.slice(start))
}

function decodeEntities(input) {
  return String(input ?? '').replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x'
      const code = parseInt(hex ? entity.slice(2) : entity.slice(1), hex ? 16 : 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    const map = {
      amp: '&',
      apos: "'",
      gt: '>',
      hellip: '…',
      lt: '<',
      mdash: '—',
      nbsp: ' ',
      ndash: '–',
      quot: '"',
    }
    return map[entity.toLowerCase()] ?? match
  })
}

function stripHtml(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li)>/gi, '\n')
      .replace(/<img[^>]*alt=["']([^"']*)["'][^>]*>/gi, '$1')
      .replace(/<[^>]*>/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n'),
  ).trim()
}

function getMid(post) {
  return String(post?.mid ?? post?.id ?? post?.bid ?? '').trim()
}

function isPinned(post) {
  const source = post?.raw || post || {}
  return Number(source.is_top ?? 0) === 1 || Boolean(source.isTop)
}

function getPostText(post) {
  if (!post) return ''
  // 归一化后的对象用 text（已是全文）；原始对象仍兼容 raw_text / text
  if (post.text != null && post.raw != null) return String(post.text || '').trim()
  return String(post.raw_text ?? post.text_raw ?? '').trim() || stripHtml(post.text ?? '')
}

function getRetweeted(post) {
  return post?.retweeted || post?.retweeted_status || null
}

function getSearchText(post) {
  if (!post) return ''
  const parts = [getPostText(post)]
  const retweeted = getRetweeted(post)
  if (retweeted) {
    parts.push(getPostText(retweeted))
    parts.push(String(retweeted.author || retweeted.user?.screen_name || ''))
  }
  if (post.regionName) parts.push(post.regionName)
  return parts.filter(Boolean).join('\n')
}

function matchesFilters(sub, post) {
  if (sub.skipForward && getRetweeted(post)) return false

  const text = getSearchText(post)
  const blockwords = (sub.blockwords || []).map((word) => String(word).trim()).filter(Boolean)
  if (blockwords.some((word) => text.includes(word))) return false

  const keywords = (sub.keywords || []).map((word) => String(word).trim()).filter(Boolean)
  if (keywords.length && !keywords.some((word) => text.includes(word))) return false

  return true
}

function normalizeUrl(rawUrl) {
  if (!rawUrl) return ''
  const url = String(rawUrl).trim()
  if (!url || url === 'false' || url === 'true' || url === 'null' || url.startsWith('javascript:')) return ''
  try {
    return new URL(url.startsWith('//') ? `https:${url}` : url, 'https://m.weibo.cn/').toString()
  } catch {
    return ''
  }
}

function getImageUrls(post) {
  const result = []

  // PC 接口：pic_infos 是以 pic_id 为键的对象，pic_ids 决定顺序
  const picInfos = post?.picInfos || post?.pic_infos || {}
  const picIds = post?.picIds || (Array.isArray(post?.pic_ids) ? post.pic_ids.map(String) : [])
  if (Object.keys(picInfos).length) {
    const ids = picIds.length ? picIds : Object.keys(picInfos)
    for (const pid of ids) {
      const info = picInfos[pid] || {}
      const url = normalizeUrl(info?.large?.url || info?.url || info?.thumbnail)
      if (url) result.push(url)
    }
  }

  // 移动端接口：pics 数组
  const pics = Array.isArray(post?.pics) ? post.pics : []
  if (!result.length) {
    if (Array.isArray(post?.pic_ids) && post.pic_ids.length) {
      for (const pid of post.pic_ids) {
        const pic = pics.find((item) => String(item?.pid ?? item?.id) === String(pid))
          || pics[result.length]
        const url = normalizeUrl(pic?.large?.url || pic?.url || pic?.thumbnail)
        if (url) result.push(url)
      }
    } else {
      for (const pic of pics) {
        const url = normalizeUrl(pic?.large?.url || pic?.url || pic?.thumbnail)
        if (url) result.push(url)
      }
    }
  }

  return [...new Set(result)]
}

async function fetchPosts(ctx, config, state, uid) {
  const mode = config.apiMode || 'pc'
  const usePc = mode === 'pc' || mode === 'auto'

  let posts = []
  let pcError = null
  if (usePc) {
    try {
      posts = await fetchPcPosts(ctx, config, state, uid)
    } catch (error) {
      pcError = error
      if (mode === 'pc') throw error
      if (config.debug) logger.info(`PC 接口失败，回退移动端：${error.message}`)
    }
  }

  if (!usePc || (mode === 'auto' && (pcError || !posts.length))) {
    try {
      posts = await fetchMobilePosts(ctx, config, state, uid)
    } catch (error) {
      if (pcError) throw pcError
      throw error
    }
  }

  const result = []
  for (const post of posts) {
    if (isPlaceholderPost(post)) {
      if (config.debug) logger.info(`跳过受限/占位微博：${post.mid}（${post.text.slice(0, 30)}）`)
      continue
    }
    post.text = await expandLongText(ctx, config, state, post)
    if (post.retweeted) post.retweeted.text = await expandLongText(ctx, config, state, post.retweeted)
    result.push(post)
  }
  return result
}

function subscriptionKey(sub) {
  const channels = [...new Set((sub.channels || []).map(String))].sort().join(',')
  return `${sub.uid}|${channels}`
}

async function saveState(ctx, key, post) {
  const mid = getMid(post)
  if (!mid) return
  await ctx.database.upsert('weibo_qq_broadcast', [{
    key,
    mid,
    updatedAt: Date.now(),
  }])
}

function formatPost(config, sub, post) {
  const author = post.author || String(post.user?.screen_name || post.user?.name || '微博用户').trim()
  const text = getPostText(post)
  const showLink = sub.showLink ?? config.showLink ?? true

  // 超话帖子在标题上标注来源超话，便于区分普通微博
  const topic = post.regionName ? `\n超话：#${post.regionName}#` : ''
  let content = `${author} 发布了微博：${topic}\n${text}`.trim()

  const retweeted = getRetweeted(post)
  if (retweeted) {
    const rtAuthor = retweeted.author || String(retweeted.user?.screen_name || '微博用户').trim()
    const rtText = getPostText(retweeted)
    if (rtText) content += `\n\n转发 ${rtAuthor}：\n${rtText}`
  }

  if (showLink) {
    const mid = getMid(post)
    if (mid) content += `\n\n原微博：https://m.weibo.cn/status/${mid}`
  }

  return content
}

async function buildElements(ctx, config, state, sub, post, channelId) {
  const bot = resolveBot(ctx, config, sub, channelId)
  const elements = []

  const mentionAll = sub.mentionAll ?? config.mentionAll ?? false
  if (mentionAll) {
    if (bot?.platform === 'qqguild') elements.push(h('at', { type: 'all' }))
    else elements.push(h.text('@全体成员 '))
  }

  elements.push(h.text(formatPost(config, sub, post)))

  const sendImages = sub.sendImages ?? config.sendImages ?? true
  if (sendImages) {
    const maxImages = Number(sub.maxImages ?? config.maxImages ?? 4)
    const urls = getImageUrls(post).slice(0, Math.max(0, maxImages))

    for (const url of urls) {
      try {
        const response = await ctx.http(url, {
          method: 'GET',
          responseType: 'arraybuffer',
          headers: buildHeaders(config, state, 'https://weibo.com/'),
          timeout: 20000,
        })

        const data = response.data
        const byteLength = data?.byteLength ?? data?.length ?? 0
        if (!byteLength) continue
        if (byteLength > 10 * 1024 * 1024) {
          if (config.debug) logger.info(`图片过大，已跳过：${url}`)
          continue
        }

        const contentType = response.headers.get('content-type') || ''
        const mime = contentType.startsWith('image/') ? contentType.split(';')[0] : 'image/jpeg'
        elements.push(h.image(data, mime))
      } catch (error) {
        logger.warn(`下载微博图片失败（${url}）：${error.message}`)
      }
    }
  }

  return elements
}

function resolveBot(ctx, config, sub, channelId) {
  const platform = sub.platform || config.platform || 'qq'
  const preferredSelfId = String(sub.selfId || config.selfId || '').trim()

  if (preferredSelfId) {
    const bot = ctx.bots[`${platform}:${preferredSelfId}`]
    if (bot && bot.isActive) return bot
  }

  const candidates = [...ctx.bots.values()].filter((bot) => (
    bot.platform === platform && bot.isActive
  ))

  if (config.debug && !candidates.length) {
    logger.info(`未找到在线 Bot：platform=${platform}，channel=${channelId}`)
  }

  return candidates[0]
}

async function broadcast(ctx, config, state, sub, post) {
  const mid = getMid(post)

  for (const rawChannelId of sub.channels || []) {
    const channelId = String(rawChannelId).trim()
    if (!channelId) continue

    const bot = resolveBot(ctx, config, sub, channelId)
    if (!bot) {
      logger.warn(`无法推送微博 ${mid}：未找到在线的 ${sub.platform || config.platform} 机器人，目标 ${channelId}`)
      continue
    }

    try {
      const elements = await buildElements(ctx, config, state, sub, post, channelId)
      await bot.sendMessage(channelId, elements)
      if (config.debug) {
        logger.info(`已推送 ${mid} -> ${bot.platform}:${bot.selfId} / ${channelId}`)
      }
    } catch (error) {
      logger.warn(`推送微博 ${mid} 到 ${channelId} 失败：${error.message}`)
    }
  }
}

/* --------------------------- 扫码登录与 Cookie 状态 --------------------------- */

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildCookieString(cookies) {
  return cookies
    .filter((cookie) => cookie?.name && cookie?.value && (
      !cookie.domain || cookie.domain.includes('weibo.com') || cookie.domain.includes('weibo.cn')
    ))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ')
}

function normalizeProfile(user) {
  if (!user) return null
  const screenName = String(user.screen_name || user.screenName || user.name || '').trim()
  const uid = String(user.id ?? user.uid ?? user.user_id ?? '').trim()
  let avatarUrl = String(user.profile_image_url || user.avatar_hd || user.avatar_large || '').trim()
  if (avatarUrl.startsWith('//')) avatarUrl = `https:${avatarUrl}`
  if (!screenName && !uid && !avatarUrl) return null
  return { screenName: screenName || null, uid: uid || null, avatarUrl: avatarUrl || null }
}

async function loadCookieRecord(ctx) {
  try {
    const rows = await ctx.database.get(COOKIE_TABLE, 'default')
    return rows[0] || null
  } catch {
    return null
  }
}

async function saveCookieRecord(ctx, cookieString, cookies) {
  await ctx.database.upsert(COOKIE_TABLE, [{
    id: 'default',
    value: cookieString,
    cookies: JSON.stringify(cookies || []),
    updatedAt: Date.now(),
  }])
}

async function loadCookie(ctx, config, state) {
  const record = await loadCookieRecord(ctx)
  state.cookie = String(record?.value || '')
  try {
    state.cookies = record?.cookies ? JSON.parse(record.cookies) : []
  } catch {
    state.cookies = []
  }
  if (!Array.isArray(state.cookies)) state.cookies = []
  state.lastCookieRefreshAt = record?.updatedAt || null
  if (!state.cookie) return false
  await checkCookieValidity(ctx, config, state, { notify: false })
  return true
}

async function checkCookieValidity(ctx, config, state, options = {}) {
  const previous = state.validity
  const cookie = getCookie(config, state)

  if (!cookie) {
    state.validity = 'none'
    state.cookieStatusText = '未登录，请在插件配置页扫码'
    state.profile = null
    state.lastError = null
    state.lastCheckedAt = Date.now()
    return false
  }

  try {
    const response = await ctx.http(WEIBO_CONFIG_API, {
      method: 'GET',
      headers: buildHeaders(config, state, 'https://m.weibo.cn/'),
      responseType: 'json',
      timeout: 15000,
    })
    const payload = parseLooseJson(response.data)
    const valid = payload?.data?.login === true && Boolean(payload?.data?.user)

    state.validity = valid ? 'valid' : 'invalid'
    state.cookieStatusText = valid ? '有效' : '已失效，请重新扫码登录'
    state.profile = valid ? normalizeProfile(payload.data.user) : null
    state.lastError = null
  } catch (error) {
    const status = error?.response?.status
    if ([401, 403, 418].includes(status)) {
      state.validity = 'invalid'
      state.cookieStatusText = '已失效，请重新扫码登录'
    } else {
      state.validity = 'unknown'
      state.cookieStatusText = '检测失败，请稍后重试'
    }
    state.profile = null
    state.lastError = error.message || String(error)
  }

  state.lastCheckedAt = Date.now()

  if (options.notify) {
    const justExpired = previous === 'valid' && state.validity === 'invalid'
    const cooldown = Number(config.expiryNotifyCooldown || 720) * 60 * 1000
    const shouldRepeat = state.validity === 'invalid' && Date.now() - state.lastExpiryNotifyAt > cooldown
    if (justExpired || shouldRepeat) {
      await notifyExpiry(ctx, config, state)
    }
  }

  return state.validity === 'valid'
}

async function notifyExpiry(ctx, config, state) {
  if (config.expiryNotify === false) return

  const text = String(config.expiryNoticeText || '').trim()
    || '微博 Cookie 已失效，播报可能停止。请在 Koishi 控制台的「微博 Cookie 登录」面板重新扫码登录。'

  const targets = []
  const seen = new Set()

  if (Array.isArray(config.expiryNotifyChannels) && config.expiryNotifyChannels.length) {
    for (const channel of config.expiryNotifyChannels) {
      targets.push({ sub: { platform: config.platform, selfId: config.selfId }, channel: String(channel) })
    }
  } else {
    for (const sub of config.subscriptions || []) {
      for (const channel of sub.channels || []) {
        targets.push({ sub, channel: String(channel) })
      }
    }
  }

  for (const target of targets) {
    const platform = target.sub.platform || config.platform || 'qq'
    const key = `${platform}:${target.channel}`
    if (seen.has(key)) continue
    seen.add(key)

    const bot = resolveBot(ctx, config, target.sub, target.channel)
    if (!bot) continue
    try {
      await bot.sendMessage(target.channel, [h.text(text)])
    } catch (error) {
      logger.warn(`发送 Cookie 失效通知到 ${target.channel} 失败：${error.message}`)
    }
  }

  for (const rawUserId of config.adminUsers || []) {
    const userId = String(rawUserId).trim()
    if (!userId) continue
    const bot = resolveBot(ctx, config, { platform: config.platform, selfId: config.selfId }, userId)
    if (!bot?.sendPrivateMessage) continue
    try {
      await bot.sendPrivateMessage(userId, [h.text(text)])
    } catch (error) {
      logger.warn(`私聊 Cookie 失效通知给 ${userId} 失败：${error.message}`)
    }
  }

  state.lastExpiryNotifyAt = Date.now()
  logger.warn('微博 Cookie 已失效，已尝试通知群/频道与管理员。')
}

async function isLoggedIn(page) {
  try {
    const cookies = await page.cookies()
    return cookies.some((cookie) => cookie.name === 'SUB')
  } catch {
    return false
  }
}

async function clickQrTabIfNeeded(page) {
  const clicked = await page.evaluate(() => {
    const keywords = ['扫码', '二维码', 'Scan', 'QR']
    const candidates = Array.from(document.querySelectorAll('button, a, div, span, li'))
    for (const element of candidates) {
      const text = element.innerText || ''
      const className = String(element.className || '')
      if (keywords.some((keyword) => text.includes(keyword)) || className.toLowerCase().includes('qr')) {
        element.click()
        return true
      }
    }
    return false
  })

  if (clicked) return

  const selectors = ['.qrcode', '.qr', '[class*="qr"]', '[class*="qrcode"]', '[data-role="qrcode"]']
  for (const selector of selectors) {
    const element = await page.$(selector)
    if (!element) continue
    try {
      await element.click()
      break
    } catch {}
  }
}

async function getQrElement(page) {
  const selectors = [
    'img[src*="qr"]',
    'img[src*="qrcode"]',
    'img[alt*="二维码"]',
    'img[alt*="QR"]',
    '.qrcode img',
    '[class*="qr"] img',
    '[class*="qrcode"] img',
    '[class*="qr"] canvas',
    'canvas',
    '.qrcode',
    '[class*="qrcode"]',
    '[id*="qr"]',
    '[data-role="qrcode"]',
  ]

  for (const selector of selectors) {
    const element = await page.$(selector)
    if (!element) continue
    const box = await element.boundingBox()
    if (box && box.width > 100 && box.height > 100) return element
  }

  const found = await page.evaluate(() => {
    const texts = ['扫描二维码登录', '打开微博手机APP', '扫一扫', 'Scan QR Code']
    const containers = Array.from(document.querySelectorAll('div, section, article, form, main'))
    for (const container of containers) {
      if (!texts.some((text) => (container.innerText || '').includes(text))) continue
      const target = container.querySelector('canvas, img, [class*="qr"], [class*="qrcode"]')
      if (!target) continue
      target.setAttribute('data-weibo-qq-broadcast-qr', 'true')
      return true
    }
    return false
  })

  if (found) return await page.$('[data-weibo-qq-broadcast-qr="true"]')

  for (const image of await page.$$('img, canvas')) {
    const box = await image.boundingBox()
    if (!box || box.width <= 100 || box.height <= 100) continue
    const ratio = box.width / box.height
    if (ratio > 0.8 && ratio < 1.2) return image
  }

  return null
}

async function captureQrFromPage(page, timeout = 1500) {
  try {
    const start = Date.now()
    let element = null
    while (Date.now() - start < timeout) {
      element = await getQrElement(page)
      if (element) break
      await wait(500)
    }
    if (!element) return { detected: false, dataUrl: null }
    const base64 = await element.screenshot({ encoding: 'base64' })
    return { detected: true, dataUrl: `data:image/png;base64,${String(base64)}` }
  } catch {
    return { detected: false, dataUrl: null }
  }
}

async function loginWithQr(ctx, state, options = {}) {
  if (!ctx.puppeteer?.page) throw new Error('未检测到可用的 Puppeteer 服务')
  if (!ctx.puppeteer.browser && typeof ctx.puppeteer.start === 'function') {
    await ctx.puppeteer.start()
  }

  const page = await ctx.puppeteer.page()
  try {
    await options.onPageCreated?.(page)
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 120000 })

    let qr = null
    for (let i = 0; i < 3; i++) {
      if (await isLoggedIn(page)) break
      await clickQrTabIfNeeded(page)
      await wait(1000)
      qr = await captureQrFromPage(page, 5000)
      if (qr.detected) break
    }

    if (await isLoggedIn(page)) {
      const cookies = await page.cookies()
      return { cookies, cookieString: buildCookieString(cookies) }
    }

    if (!qr?.detected) qr = await captureQrFromPage(page, 15000)
    if (!qr?.detected) throw new Error('未识别到微博二维码，登录页结构可能已变化')

    await options.onQrCaptured?.(qr.dataUrl)

    const start = Date.now()
    while (Date.now() - start < 180000) {
      if (await isLoggedIn(page)) break
      await wait(2000)
    }
    if (!(await isLoggedIn(page))) throw new Error('扫码登录超时')

    const cookies = await page.cookies()
    return { cookies, cookieString: buildCookieString(cookies) }
  } finally {
    await page.close().catch(() => {})
  }
}

async function renewCookies(ctx, cookies) {
  if (!ctx.puppeteer?.page) throw new Error('未检测到可用的 Puppeteer 服务')
  if (!ctx.puppeteer.browser && typeof ctx.puppeteer.start === 'function') {
    await ctx.puppeteer.start()
  }

  const page = await ctx.puppeteer.page()
  try {
    const validCookies = (cookies || []).filter((cookie) => cookie?.name && cookie?.value && cookie?.domain)
    if (validCookies.length) await page.setCookie(...validCookies)
    await page.goto('https://weibo.com/', { waitUntil: 'networkidle2', timeout: 60000 })
    await wait(3000)
    if (!(await isLoggedIn(page))) throw new Error('Cookie 续期失败，需要重新扫码登录')
    const nextCookies = await page.cookies()
    return { cookies: nextCookies, cookieString: buildCookieString(nextCookies) }
  } finally {
    await page.close().catch(() => {})
  }
}

function getLoginPanelState(ctx, config, state) {
  return {
    status: state.loginState,
    message: state.loginMessage,
    lastError: state.lastError,
    hasCookie: Boolean(getCookie(config, state)),
    usingManualCookie: Boolean(String(config.cookie || '').trim()),
    validity: state.validity,
    cookieStatusText: state.cookieStatusText,
    autoLoginEnabled: Boolean(ctx.puppeteer),
    qrImageDataUrl: state.qrImageDataUrl,
    lastQrUpdatedAt: state.lastQrUpdatedAt,
    lastCookieRefreshAt: state.lastCookieRefreshAt,
    lastCheckedAt: state.lastCheckedAt,
    profile: state.profile,
    loginUrl: LOGIN_URL,
  }
}

async function startLogin(ctx, config, state, force = false) {
  if (state.loginTask) return state.loginTask

  const serial = ++state.loginSerial
  state.loginState = 'pending'
  state.loginMessage = '请使用微博 App 扫描二维码完成登录'
  state.lastError = null

  const task = (async () => {
    if (!ctx.puppeteer) {
      state.loginState = 'error'
      state.loginMessage = '未检测到 koishi-plugin-puppeteer'
      state.lastError = '请先安装并启用 koishi-plugin-puppeteer'
      return null
    }

    try {
      const result = await loginWithQr(ctx, state, {
        onPageCreated: async (page) => {
          if (serial !== state.loginSerial) {
            await page.close().catch(() => {})
            return
          }
          state.activeLoginPage = page
          state.qrPollingTimer = setInterval(async () => {
            if (serial !== state.loginSerial || state.loginState !== 'pending' || state.qrCaptureTask) return
            state.qrCaptureTask = (async () => {
              try {
                const qr = await captureQrFromPage(state.activeLoginPage, 1200)
                if (qr.detected) {
                  state.qrImageDataUrl = qr.dataUrl
                  state.lastQrUpdatedAt = Date.now()
                }
              } catch {} finally {
                state.qrCaptureTask = null
              }
            })()
          }, 1500)
        },
        onQrCaptured: (dataUrl) => {
          if (serial !== state.loginSerial) return
          state.qrImageDataUrl = dataUrl
          state.lastQrUpdatedAt = Date.now()
        },
      })

      if (serial !== state.loginSerial) return null

      state.cookie = result.cookieString
      state.cookies = result.cookies || []
      await saveCookieRecord(ctx, state.cookie, state.cookies)

      state.loginState = 'success'
      state.loginMessage = '扫码登录成功，Cookie 已保存'
      state.qrImageDataUrl = null
      state.lastCookieRefreshAt = Date.now()
      await checkCookieValidity(ctx, config, state, { notify: false })
      if (state.profile?.screenName) {
        state.loginMessage = `扫码登录成功，当前账号：${state.profile.screenName}`
      }
      logger.info('微博扫码登录成功，Cookie 已保存到数据库。')
      return state.cookie
    } catch (error) {
      if (serial !== state.loginSerial) return null
      state.loginState = 'error'
      state.loginMessage = '扫码登录失败'
      state.lastError = error.message || String(error)
      throw error
    } finally {
      if (state.qrPollingTimer) clearInterval(state.qrPollingTimer)
      state.qrPollingTimer = null
      state.activeLoginPage = null
      if (state.loginTask === task) state.loginTask = null
    }
  })()

  state.loginTask = task
  return task
}

async function renewCookieSilently(ctx, config, state) {
  if (!ctx.puppeteer) return
  if (!state.cookies.length) return
  try {
    const result = await renewCookies(ctx, state.cookies)
    state.cookie = result.cookieString
    state.cookies = result.cookies
    await saveCookieRecord(ctx, state.cookie, state.cookies)
    state.lastCookieRefreshAt = Date.now()
    await checkCookieValidity(ctx, config, state, { notify: false })
    logger.info('微博 Cookie 已静默续期。')
  } catch (error) {
    logger.warn(`微博 Cookie 静默续期失败：${error.message}`)
  }
}

function clearCookieState(state) {
  state.cookie = ''
  state.cookies = []
  state.validity = 'none'
  state.cookieStatusText = '未登录，请在插件配置页扫码'
  state.profile = null
  state.lastError = null
  state.loginState = 'idle'
  state.loginMessage = '等待操作'
  state.qrImageDataUrl = null
  state.qrPollingTimer = null
  state.activeLoginPage = null
}

/* --------------------------------- 主流程 --------------------------------- */

async function refreshAll(ctx, config, state, options = {}) {
  await checkCookieValidity(ctx, config, state, { notify: !options.force })

  for (const sub of config.subscriptions || []) {
    if (!sub?.uid || !Array.isArray(sub.channels) || !sub.channels.length) continue

    const label = sub.name ? `${sub.name}(${sub.uid})` : String(sub.uid)
    const key = subscriptionKey(sub)

    try {
      const posts = await fetchPosts(ctx, config, state, String(sub.uid))
      const usablePosts = posts.filter((post) => !isPinned(post) && getMid(post))

      if (config.debug) {
        logger.info(`${label}：拉取到 ${posts.length} 条，过滤后 ${usablePosts.length} 条`)
      }
      if (!usablePosts.length) continue

      const record = (await ctx.database.get('weibo_qq_broadcast', key))[0]
      let queue = []

      if (options.force) {
        queue = usablePosts.slice(0, 1)
      } else if (!record) {
        await saveState(ctx, key, usablePosts[0])
        if (config.pushOnFirstPoll) queue = usablePosts.slice(0, 1)
      } else {
        const index = usablePosts.findIndex((post) => getMid(post) === record.mid)
        queue = index < 0 ? usablePosts.slice(0, 1) : usablePosts.slice(0, index).reverse()

        if (getMid(usablePosts[0]) !== record.mid) {
          await saveState(ctx, key, usablePosts[0])
        }
      }

      for (const post of queue) {
        if (!options.force && !matchesFilters(sub, post)) continue
        await broadcast(ctx, config, state, sub, post)
      }
    } catch (error) {
      logger.warn(`处理订阅 ${label} 失败：${error.message}`)
      if (config.debug) logger.warn(error.stack)
    }

    await sleep(500)
  }
}

module.exports.apply = (ctx, config) => {
  ctx.model.extend('weibo_qq_broadcast', {
    key: 'string',
    mid: 'string',
    updatedAt: 'integer',
  }, {
    primary: 'key',
  })

  ctx.model.extend(COOKIE_TABLE, {
    id: 'string',
    value: 'string',
    cookies: 'string',
    updatedAt: 'integer',
  }, {
    primary: 'id',
  })

  const state = {
    cookie: '',
    cookies: [],
    validity: 'none',
    cookieStatusText: '未登录，请在插件配置页扫码',
    profile: null,
    lastError: null,
    lastCheckedAt: null,
    lastCookieRefreshAt: null,
    lastExpiryNotifyAt: 0,
    loginState: 'idle',
    loginMessage: '等待操作',
    loginTask: null,
    loginSerial: 0,
    qrImageDataUrl: null,
    lastQrUpdatedAt: null,
    qrPollingTimer: null,
    qrCaptureTask: null,
    activeLoginPage: null,
  }

  let ready = false
  let consoleEntryRegistered = false
  let serverRoutesRegistered = false

  const registerConsoleEntry = () => {
    const consoleService = ctx.console || ctx.get?.('console')
    if (!consoleService || consoleEntryRegistered) return
    consoleService.addEntry({
      dev: path.resolve(__dirname, '../client/index.ts'),
      prod: path.resolve(__dirname, '../dist'),
    })
    consoleEntryRegistered = true
  }

  const registerServerRoutes = () => {
    const server = ctx.server || ctx.get?.('server')
    if (!server || serverRoutesRegistered) return

    server.get(`${API_PREFIX}/status`, async (koa) => {
      koa.body = getLoginPanelState(ctx, config, state)
    })

    server.post(`${API_PREFIX}/check`, async (koa) => {
      await checkCookieValidity(ctx, config, state, { notify: false })
      koa.body = getLoginPanelState(ctx, config, state)
    })

    server.post(`${API_PREFIX}/start-login`, async (koa) => {
      const force = ['1', 'true', 'yes'].includes(String(koa.query?.force || '').toLowerCase())
      void startLogin(ctx, config, state, force).catch((error) => {
        logger.warn(`页面触发扫码登录失败：${error.message}`)
      })
      koa.body = getLoginPanelState(ctx, config, state)
    })

    server.post(`${API_PREFIX}/clear`, async (koa) => {
      ++state.loginSerial
      clearCookieState(state)
      await ctx.database.upsert(COOKIE_TABLE, [{
        id: 'default',
        value: '',
        cookies: '[]',
        updatedAt: Date.now(),
      }])
      koa.body = getLoginPanelState(ctx, config, state)
    })

    serverRoutesRegistered = true
  }

  registerConsoleEntry()
  registerServerRoutes()

  ctx.on('internal/service', (serviceName) => {
    if (serviceName === 'console') registerConsoleEntry()
    if (serviceName === 'server') registerServerRoutes()
  })

  ctx.on('ready', async () => {
    await loadCookie(ctx, config, state)
    ready = true
    await refreshAll(ctx, config, state)
  })

  ctx.setInterval(async () => {
    if (!ready) return
    await refreshAll(ctx, config, state)
  }, Number(config.updateInterval || 5) * 60 * 1000)

  ctx.setInterval(async () => {
    if (!ready) return
    await checkCookieValidity(ctx, config, state, { notify: true })
  }, Number(config.cookieCheckInterval || 30) * 60 * 1000)

  ctx.command('weiboqq.cookie', '检查微博 Cookie 状态', { authority: 2 })
    .action(async () => {
      await checkCookieValidity(ctx, config, state, { notify: false })
      return `Cookie 状态：${state.cookieStatusText}`
    })

  ctx.command('weiboqq.refresh', '立即检查微博更新', { authority: 2 })
    .action(async () => {
      await refreshAll(ctx, config, state)
      return '微博更新检查已完成。'
    })

  ctx.command('weiboqq.test', '强制推送各订阅最新微博，用于调试', { authority: 2 })
    .action(async () => {
      await refreshAll(ctx, config, state, { force: true })
      return '测试推送已完成。'
    })

  ctx.command('weiboqq.list', '查看当前微博订阅', { authority: 1 })
    .action(() => {
      const subs = config.subscriptions || []
      if (!subs.length) return '当前没有配置微博订阅。'
      return subs.map((sub, index) => {
        const channels = (sub.channels || []).join(', ')
        return `${index + 1}. ${sub.name || sub.uid} (${sub.uid}) [${sub.platform || config.platform}] -> ${channels}`
      }).join('\n')
    })
}
