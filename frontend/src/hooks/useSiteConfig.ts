/**
 * useSiteConfig - 加载站点配置（site_name / site_description / allow_register）
 *
 * 从后端 GET /auth/site-config 读取，缓存到 localStorage。
 * 登录页、注册页、主布局等地方用 siteConfig.siteName 替换硬编码的 "SceneGen"。
 */
import { useEffect, useState } from 'react'
import { authService } from '@/api/services'

export interface SiteConfig {
  site_name: string
  site_description: string
  allow_register: boolean
}

const CACHE_KEY = 'site_config'

function loadFromCache(): SiteConfig | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

let _cached: SiteConfig | null = loadFromCache()

export function useSiteConfig(): SiteConfig {
  const [config, setConfig] = useState<SiteConfig>(
    _cached || { site_name: 'SceneGen', site_description: 'AI短剧生成平台', allow_register: true }
  )

  useEffect(() => {
    if (_cached) return  // 已有缓存不重复请求
    authService.siteConfig()
      .then((data: any) => {
        const cfg: SiteConfig = {
          site_name: data?.site_name || 'SceneGen',
          site_description: data?.site_description || 'AI短剧生成平台',
          allow_register: data?.allow_register !== false,
        }
        _cached = cfg
        localStorage.setItem(CACHE_KEY, JSON.stringify(cfg))
        setConfig(cfg)
      })
      .catch(() => { /* 后端不可用，用默认值 */ })
  }, [])

  return config
}

/** 刷新缓存（管理员改了设置后调用） */
export function refreshSiteConfig() {
  _cached = null
  localStorage.removeItem(CACHE_KEY)
}
