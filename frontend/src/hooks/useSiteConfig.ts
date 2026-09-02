/**
 * useSiteConfig - 加载站点配置（site_name / site_description / allow_register）
 *
 * 从后端 GET /auth/site-config 读取，缓存到 localStorage（带 TTL）。
 * 登录页、注册页、主布局等地方用 siteConfig.siteName 替换硬编码的 "SceneGen"。
 *
 * 管理员在「系统设置」改了站点名/描述后调用 refreshSiteConfig()，
 * 会立即重新拉取并通知所有使用该配置的组件更新 —— 无需刷新页面。
 */
import { useEffect, useState } from 'react'
import { authService } from '@/api/services'

export interface SiteConfig {
  site_name: string
  site_description: string
  allow_register: boolean
  task_poll_timeout_seconds: number
  /** 联系方式（协议/隐私页「联系我们」展示，后台系统设置可配） */
  contact_email: string
  contact_qq: string
  contact_phone: string
}

const CACHE_KEY = 'site_config'
// 缓存 TTL：避免陈旧缓存长期命中（管理员改了设置后，其他在线用户最多等这么久）
const CACHE_TTL = 5 * 60 * 1000 // 5 分钟

const DEFAULT_CONFIG: SiteConfig = {
  site_name: 'SceneGen',
  site_description: 'AI短剧生成平台',
  allow_register: true,
  task_poll_timeout_seconds: 600,
  contact_email: '',
  contact_qq: '',
  contact_phone: '',
}

/** 默认 <title>（配置缺失或加载失败时的兜底） */
const DEFAULT_TITLE = `${DEFAULT_CONFIG.site_name} - ${DEFAULT_CONFIG.site_description}`

/** 把站点配置同步到 document.title，配置缺失则回退默认值 */
function applyDocumentTitle(cfg: SiteConfig) {
  const name = cfg?.site_name?.trim()
  const desc = cfg?.site_description?.trim()
  // 名称和描述都缺失才用默认值；只有一项也尽量拼接展示
  const title = (!name && !desc)
    ? DEFAULT_TITLE
    : [name, desc].filter(Boolean).join(' - ')
  if (typeof document !== 'undefined') {
    document.title = title
  }
}

interface CachedEntry {
  data: SiteConfig
  ts: number
}

function loadFromCache(): SiteConfig | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const entry: CachedEntry = JSON.parse(raw)
    // 缓存过期则视为无缓存，强制重新拉取
    if (!entry?.ts || Date.now() - entry.ts > CACHE_TTL) return null
    return entry.data ?? null
  } catch {
    return null
  }
}

function saveCache(cfg: SiteConfig) {
  const entry: CachedEntry = { data: cfg, ts: Date.now() }
  localStorage.setItem(CACHE_KEY, JSON.stringify(entry))
}

// ---- 简单的发布/订阅，让 refreshSiteConfig 能通知所有消费组件 ----
type Listener = () => void
const listeners = new Set<Listener>()
function subscribe(l: Listener): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}
function notify() {
  listeners.forEach((l) => l())
}

// ---- 当前内存中的配置快照（所有消费组件共享）----
let _snapshot: SiteConfig = loadFromCache() || { ...DEFAULT_CONFIG }
let _loading = false

// 模块加载时先用缓存/默认值同步一次 <title>，避免首屏停留在硬编码标题
applyDocumentTitle(_snapshot)

async function fetchSiteConfig(): Promise<SiteConfig> {
  const data: any = await authService.siteConfig()
  const cfg: SiteConfig = {
    site_name: data?.site_name || DEFAULT_CONFIG.site_name,
    site_description: data?.site_description || DEFAULT_CONFIG.site_description,
    allow_register: data?.allow_register !== false,
    task_poll_timeout_seconds: Math.max(60, Number(data?.task_poll_timeout_seconds) || DEFAULT_CONFIG.task_poll_timeout_seconds),
    contact_email: data?.contact_email || '',
    contact_qq: data?.contact_qq || '',
    contact_phone: data?.contact_phone || '',
  }
  saveCache(cfg)
  return cfg
}

export function useSiteConfig(): SiteConfig {
  const [config, setConfig] = useState<SiteConfig>(_snapshot)

  useEffect(() => {
    let alive = true

    // 订阅外部刷新（管理员改了设置后触发）：同步更新组件状态与 <title>
    const unsubscribe = subscribe(() => {
      if (alive) {
        setConfig(_snapshot)
        applyDocumentTitle(_snapshot)
      }
    })

    // 缓存缺失/过期时拉取；命中则直接用快照，不阻塞渲染
    if (!_loading && loadFromCache() === null) {
      _loading = true
      fetchSiteConfig()
        .then((cfg) => {
          _snapshot = cfg
          if (alive) setConfig(cfg)
          applyDocumentTitle(cfg)
          notify()
        })
        .catch(() => {
          /* 后端不可用，用默认值 */
        })
        .finally(() => {
          _loading = false
        })
    }

    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  return config
}

/**
 * 刷新站点配置（管理员在「系统设置」保存后调用）。
 * 清除本地缓存并立即从后端重新拉取，所有使用 useSiteConfig 的组件会自动更新，
 * 浏览器标签页 <title> 也会同步刷新。
 */
export async function refreshSiteConfig() {
  localStorage.removeItem(CACHE_KEY)
  _loading = true
  try {
    const cfg = await fetchSiteConfig()
    _snapshot = cfg
    applyDocumentTitle(cfg)
    notify()
  } catch {
    // 拉取失败时仅清缓存，组件下次 mount 时会重试
  } finally {
    _loading = false
  }
}

/**
 * 同步读取任务轮询超时（秒）。供各页面轮询逻辑计算 maxAttempts 使用。
 * 直接读内存快照，不阻塞轮询启动；管理员改设置后通过 refreshSiteConfig 刷新快照。
 */
export function getTaskPollTimeout(): number {
  return _snapshot?.task_poll_timeout_seconds || DEFAULT_CONFIG.task_poll_timeout_seconds
}
