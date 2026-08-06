/**
 * Auth Utilities - 认证相关工具函数
 */
import React from 'react'

const ACCESS_TOKEN_KEY = 'access_token'
const REFRESH_TOKEN_KEY = 'refresh_token'
const USER_KEY = 'user'

// ==================== 当前用户状态（可订阅） ====================
// 之所以单独维护一份内存状态：角色（role）这类字段可能在登录后被管理员修改，
// 仅靠 localStorage 快照会让「管理后台」入口在刷新后不更新。
// 这里提供 saveUser 时同步发布，组件通过 useCurrentUser() 订阅即可拿到最新值。
type Listener = () => void
let currentUser: any = readUserFromStorage()
const userListeners = new Set<Listener>()

function readUserFromStorage(): any {
  const userStr = localStorage.getItem(USER_KEY)
  if (!userStr) return null
  try {
    return JSON.parse(userStr)
  } catch {
    return null
  }
}

function emitUserChange() {
  currentUser = readUserFromStorage()
  userListeners.forEach((l) => l())
}

/**
 * 订阅当前用户状态的 React Hook。
 * - saveUser / clearAuthStorage 调用后会自动重渲染
 * - 内部仍以 localStorage 为持久化源，刷新页面后首次读取即最新缓存
 */
export function useCurrentUser(): any {
  return React.useSyncExternalStore(
    (listener: Listener) => {
      userListeners.add(listener)
      return () => userListeners.delete(listener)
    },
    () => currentUser, // 服务端快照（本项目为 SPA，与服务端一致）
    () => currentUser,
  )
}

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
  emitUserChange()
}

/**
 * 保存用户信息
 */
export function saveUser(user: any): void {
  localStorage.setItem(USER_KEY, JSON.stringify(user))
  emitUserChange()
}

/**
 * 获取当前用户信息
 */
export function getCurrentUser(): any | null {
  return readUserFromStorage()
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
