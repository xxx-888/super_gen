/**
 * Auth Utilities - 认证相关工具函数
 */

const ACCESS_TOKEN_KEY = 'access_token'
const REFRESH_TOKEN_KEY = 'refresh_token'
const USER_KEY = 'user'

/**
 * 获取访问令牌
 */
export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_TOKEN_KEY)
}

/**
 * 设置访问令牌
 */
export function setAccessToken(token: string): void {
  localStorage.setItem(ACCESS_TOKEN_KEY, token)
}

/**
 * 获取刷新令牌
 */
export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY)
}

/**
 * 清除所有认证信息
 */
export function clearAuthStorage(): void {
  localStorage.removeItem(ACCESS_TOKEN_KEY)
  localStorage.removeItem(REFRESH_TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
}

/**
 * 保存用户信息
 */
export function saveUser(user: any): void {
  localStorage.setItem(USER_KEY, JSON.stringify(user))
}

/**
 * 获取当前用户信息
 */
export function getCurrentUser(): any | null {
  const userStr = localStorage.getItem(USER_KEY)
  if (!userStr) return null
  try {
    return JSON.parse(userStr)
  } catch {
    return null
  }
}

/**
 * 检查是否已登录
 */
export function isAuthenticated(): boolean {
  return !!getAccessToken()
}

/**
 * 检查是否是管理员
 */
export function isAdmin(): boolean {
  const user = getCurrentUser()
  return user?.role === 'admin'
}
