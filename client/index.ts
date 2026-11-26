import { SchemaBase } from '@koishijs/client'
import { defineComponent, h, onMounted, onUnmounted, ref } from 'vue'

const API_PREFIX = '/weibo-qq-broadcast/api'
const LOGIN_SCHEMA_ROLE = 'weibo-qq-broadcast-login'

interface WeiboProfile {
  screenName: string | null
  uid: string | null
  avatarUrl: string | null
}

interface LoginPanelState {
  status: 'idle' | 'pending' | 'success' | 'error'
  message: string
  lastError: string | null
  hasCookie: boolean
  usingManualCookie: boolean
  validity: 'none' | 'valid' | 'invalid' | 'unknown'
  cookieStatusText: string
  autoLoginEnabled: boolean
  qrImageDataUrl: string | null
  lastQrUpdatedAt: number | null
  lastCookieRefreshAt: number | null
  lastCheckedAt: number | null
  profile: WeiboProfile | null
  loginUrl: string
  smsPhone: string | null
  smsPending: boolean
}

const requestApi = async <T>(path: string, method = 'GET', body?: Record<string, unknown>): Promise<T> => {
  const response = await fetch(`${API_PREFIX}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `请求失败：${response.status}`)
  }
  return await response.json() as T
}

const formatTime = (value: number | null | undefined) => {
  if (!value) return '暂无'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

const styles = {
  card: 'background: var(--card-bg, #fff); border: 1px solid var(--border, #d0d7de); border-radius: 16px; padding: 16px; box-shadow: 0 4px 16px rgba(31, 35, 40, 0.06);',
  embedCard: 'width: 100%; background: var(--card-bg, #fff); border: 1px solid var(--border, #d0d7de); border-radius: 14px; padding: 14px;',
  title: 'font-size: 15px; font-weight: 700; margin-bottom: 12px;',
  row: 'display: grid; grid-template-columns: minmax(200px, 280px) minmax(0, 1fr); gap: 12px;',
  infoBox: 'display: grid; align-content: start; gap: 8px;',
  info: 'font-size: 13px; line-height: 1.6; padding: 8px 10px; border-radius: 8px; background: var(--bg2, rgba(127,127,127,0.08));',
  label: 'display: inline-block; min-width: 104px; font-weight: 700;',
  qrBox: 'display: flex; align-items: center; justify-content: center; min-height: 320px; border: 1px dashed var(--border, #d0d7de); border-radius: 12px; overflow: hidden; background: var(--bg2, rgba(127,127,127,0.06));',
  qrImage: 'display: block; width: 100%; max-width: 300px; height: auto;',
  placeholder: 'padding: 20px; font-size: 13px; color: var(--fg2, #57606a); text-align: center; line-height: 1.8; white-space: pre-line;',
  buttons: 'display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px;',
  button: 'appearance: none; border: 1px solid var(--border, #d0d7de); background: var(--bg2, #f6f8fa); color: var(--fg1, #1f2328); padding: 7px 12px; border-radius: 8px; cursor: pointer; font-size: 13px;',
  primary: 'background: #0969da; border-color: #0969da; color: #fff;',
  disabled: 'opacity: 0.5; cursor: not-allowed;',
  danger: 'color: #cf222e;',
  warning: 'color: #9a6700;',
  error: 'color: #cf222e;',
  smsBox: 'margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border, #d0d7de); display: grid; gap: 8px;',
  smsTitle: 'font-size: 13px; font-weight: 700;',
  smsRow: 'display: flex; gap: 8px; align-items: center; flex-wrap: wrap;',
  input: 'appearance: none; border: 1px solid var(--border, #d0d7de); background: var(--bg, #fff); color: var(--fg1, #1f2328); padding: 7px 10px; border-radius: 8px; font-size: 13px; min-width: 180px;',
}

const useLoginState = () => {
  const state = ref<LoginPanelState | null>(null)
  const busy = ref(false)
  const smsBusy = ref(false)
  const actionError = ref('')
  let timer: number | null = null

  const captureError = (error: unknown) => {
    actionError.value = error instanceof Error ? error.message : String(error)
  }

  const refresh = async () => {
    try {
      state.value = await requestApi<LoginPanelState>('/status')
    } catch (error) {
      captureError(error)
    }
  }

  const startLogin = async () => {
    busy.value = true
    actionError.value = ''
    try {
      state.value = await requestApi<LoginPanelState>('/start-login?force=1', 'POST')
    } catch (error) {
      captureError(error)
    } finally {
      busy.value = false
      await refresh()
    }
  }

  const check = async () => {
    busy.value = true
    actionError.value = ''
    try {
      state.value = await requestApi<LoginPanelState>('/check', 'POST')
    } catch (error) {
      captureError(error)
    } finally {
      busy.value = false
    }
  }

  const clear = async () => {
    busy.value = true
    actionError.value = ''
    try {
      state.value = await requestApi<LoginPanelState>('/clear', 'POST')
    } catch (error) {
      captureError(error)
    } finally {
      busy.value = false
    }
  }

  interface SmsResult {
    success: boolean
    error?: string
    message?: string
    state?: LoginPanelState
  }

  const sendSms = async (phone: string) => {
    smsBusy.value = true
    actionError.value = ''
    try {
      const result = await requestApi<SmsResult>('/sms/send', 'POST', { phone })
      if (!result.success) throw new Error(result.error || '验证码发送失败')
      if (result.state) state.value = result.state
      await refresh()
      return true
    } catch (error) {
      captureError(error)
      await refresh()
      return false
    } finally {
      smsBusy.value = false
    }
  }

  const loginWithSms = async (code: string) => {
    smsBusy.value = true
    actionError.value = ''
    try {
      const result = await requestApi<SmsResult>('/sms/login', 'POST', { code })
      if (!result.success) throw new Error(result.error || '短信登录失败')
      if (result.state) state.value = result.state
      await refresh()
      return true
    } catch (error) {
      captureError(error)
      await refresh()
      return false
    } finally {
      smsBusy.value = false
    }
  }

  onMounted(async () => {
    await refresh()
    timer = window.setInterval(() => {
      void refresh()
    }, 1000)
  })

  onUnmounted(() => {
    if (timer !== null) window.clearInterval(timer)
  })

  return { state, busy, smsBusy, actionError, refresh, startLogin, check, clear, sendSms, loginWithSms }
}

const LoginPanelCard = defineComponent({
  name: 'WeiboQqBroadcastLoginCard',
  props: {
    embedded: Boolean,
  },
  setup(props) {
    const { state, busy, smsBusy, actionError, refresh, startLogin, check, clear, sendSms, loginWithSms } = useLoginState()
    const phone = ref('')
    const smsCode = ref('')

    return () => {
      const current = state.value
      const validity = current?.validity || 'none'
      const validityColor = validity === 'valid'
        ? '#1a7f37'
        : validity === 'invalid'
          ? '#cf222e'
          : '#57606a'
      const waiting = busy.value || current?.status === 'pending'

      return h('div', {
        style: props.embedded ? styles.embedCard : styles.card,
        'data-weibo-qq-broadcast-login-panel': 'true',
      }, [
        h('div', { style: styles.title }, '微博 Cookie 登录'),

        h('div', { style: styles.row }, [
          h('div', { style: styles.qrBox }, current?.qrImageDataUrl
            ? h('img', { src: current.qrImageDataUrl, style: styles.qrImage })
            : h('div', { style: styles.placeholder }, waiting
              ? '正在从微博登录页提取二维码，请稍候…'
              : current?.autoLoginEnabled === false
                ? '未检测到 koishi-plugin-puppeteer。\n请先安装并启用该插件，然后点击「扫码登录」。'
                : `当前还没有可用二维码。\n点击「扫码登录」后将自动打开登录页并提取二维码。\n登录页：${current?.loginUrl || 'https://passport.weibo.com/'}`)),

          h('div', { style: styles.infoBox }, [
            h('div', { style: styles.info }, [
              h('span', { style: styles.label }, 'Cookie 状态'),
              h('span', { style: `color: ${validityColor}; font-weight: 700;` }, current?.cookieStatusText || '检测中'),
            ]),
            h('div', { style: styles.info }, [
              h('span', { style: styles.label }, '登录状态'),
              h('span', null, current?.message || current?.status || '等待操作'),
            ]),
            h('div', { style: styles.info }, [
              h('span', { style: styles.label }, '上次检测'),
              h('span', null, formatTime(current?.lastCheckedAt)),
            ]),
            h('div', { style: styles.info }, [
              h('span', { style: styles.label }, 'Cookie 更新'),
              h('span', null, formatTime(current?.lastCookieRefreshAt)),
            ]),
            current?.profile?.screenName
              ? h('div', { style: styles.info }, [
                h('span', { style: styles.label }, '当前账号'),
                h('span', null, `${current.profile.screenName}${current.profile.uid ? ` (UID ${current.profile.uid})` : ''}`),
              ])
              : null,
            current?.usingManualCookie
              ? h('div', { style: `${styles.info};${styles.warning}` }, '当前使用手动填写的 Cookie，扫码登录结果不会覆盖它。')
              : null,
            current?.lastError
              ? h('div', { style: `${styles.info};${styles.error}` }, `错误：${current.lastError}`)
              : null,
            actionError.value
              ? h('div', { style: `${styles.info};${styles.error}` }, `操作失败：${actionError.value}`)
              : null,
          ]),
        ]),

        h('div', { style: styles.buttons }, [
          h('button', {
            style: `${styles.button} ${styles.primary}${busy.value ? ` ${styles.disabled}` : ''}`,
            disabled: busy.value,
            onClick: () => void startLogin(),
          }, waiting ? '请求中…' : '扫码登录 / 刷新二维码'),
          h('button', {
            style: `${styles.button}${busy.value ? ` ${styles.disabled}` : ''}`,
            disabled: busy.value,
            onClick: () => void check(),
          }, '立即检查'),
          h('button', {
            style: `${styles.button} ${styles.danger}${busy.value ? ` ${styles.disabled}` : ''}`,
            disabled: busy.value,
            onClick: () => void clear(),
          }, '清除 Cookie'),
        ]),

        // 短信验证码登录区
        h('div', { style: styles.smsBox }, [
          h('div', { style: styles.smsTitle }, '短信验证码登录'),
          h('div', { style: 'font-size: 12px; color: var(--fg2, #57606a); line-height: 1.6;' },
            '输入手机号获取验证码，登录成功后自动保存 Cookie。需要安装并启用 koishi-plugin-puppeteer。'),
          h('div', { style: styles.smsRow }, [
            h('input', {
              style: styles.input,
              type: 'tel',
              placeholder: '手机号',
              value: phone.value,
              disabled: smsBusy.value,
              onInput: (e: Event) => { phone.value = (e.target as HTMLInputElement).value },
            }),
            h('button', {
              style: `${styles.button}${smsBusy.value || !phone.value ? ` ${styles.disabled}` : ''}`,
              disabled: smsBusy.value || !phone.value,
              onClick: () => void sendSms(phone.value),
            }, smsBusy.value && !current?.smsPending ? '发送中…' : '获取验证码'),
          ]),
          current?.smsPending ? h('div', { style: styles.smsRow }, [
            h('input', {
              style: styles.input,
              type: 'text',
              placeholder: '短信验证码',
              value: smsCode.value,
              disabled: smsBusy.value,
              onInput: (e: Event) => { smsCode.value = (e.target as HTMLInputElement).value },
            }),
            h('button', {
              style: `${styles.button} ${styles.primary}${smsBusy.value || !smsCode.value ? ` ${styles.disabled}` : ''}`,
              disabled: smsBusy.value || !smsCode.value,
              onClick: () => void loginWithSms(smsCode.value),
            }, smsBusy.value ? '登录中…' : '登录'),
          ]) : null,
          current?.smsPending
            ? h('div', { style: 'font-size: 12px; color: var(--fg2, #57606a);' },
              `已向 ${current.smsPhone || '手机号'} 发送验证码，请输入后点击「登录」。重新获取请再次点击「获取验证码」。`)
            : null,
        ]),
      ])
    }
  },
})

const LoginConfigPanel = defineComponent({
  name: 'WeiboQqBroadcastLoginConfigPanel',
  props: {
    schema: Object,
    modelValue: Object,
    initial: Object,
    disabled: Boolean,
    prefix: String,
    extra: Object,
  },
  setup(props) {
    return () => h(SchemaBase as any, {
      schema: props.schema,
      modelValue: props.modelValue,
      initial: props.initial,
      disabled: props.disabled,
      prefix: props.prefix,
      extra: props.extra,
    }, {
      title: () => '微博 Cookie 登录',
      desc: () => '支持扫码登录与短信验证码登录，成功后自动保存 Cookie 并显示有效性。Cookie 失效时会通知配置的群/频道与管理员。',
      control: () => null,
      collapse: () => h('div', { style: 'margin-top: 12px;' }, [
        h(LoginPanelCard, { embedded: true }),
      ]),
    })
  },
})

const hasLoginSchemaExtension = Array.from((SchemaBase as any).extensions || []).some((extension: any) => {
  return extension.role === LOGIN_SCHEMA_ROLE
})

if (!hasLoginSchemaExtension) {
  ;(SchemaBase as any).extensions.add({
    type: 'object',
    role: LOGIN_SCHEMA_ROLE,
    component: LoginConfigPanel,
    validate: (value: any) => typeof value === 'object',
    important: true,
  })
}

export default () => {}
