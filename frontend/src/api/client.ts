/**
 * API Client - HTTP请求封装
 *
 * 基于axios的API客户端，提供:
 * - 自动添加认证Token
 * - 统一错误处理
 * - 请求/响应拦截
 * - Token自动刷新
 */
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios'
import { Message } from '@arco-design/web-react'
import { getAccessToken, setAccessToken, clearAuthStorage } from '@/utils/auth'

// 创建axios实例
const client: AxiosInstance = axios.create({
  baseURL: '/api/v1',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
})

// 请求拦截器 - 添加Token
client.interceptors.request.use(
  (config) => {
    const token = getAccessToken()
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// 响应拦截器 - 统一处理错误和Token刷新
let isRefreshing = false
let failedQueue: Array<{
  resolve: (value?: unknown) => void
  reject: (reason?: unknown) => void
}> = []

const processQueue = (error: unknown, token: string | null = null) => {
  failedQueue.forEach((promise) => {
    if (error) {
      promise.reject(error)
    } else {
      promise.resolve(token)
    }
  })
  failedQueue = []
}

client.interceptors.response.use(
  (response: AxiosResponse) => {
    // 直接返回data层
    return response.data
  },
  async (error) => {
    const originalRequest = error.config

    // Token过期，尝试刷新
    if (
      error.response?.status === 401 &&
      !originalRequest._retry &&
      !originalRequest.url?.includes('/auth/')
    ) {
      if (isRefreshing) {
        // 如果正在刷新，加入队列等待
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject })
        }).then(() => {
          return client(originalRequest)
        })
      }

      originalRequest._retry = true
      isRefreshing = true

      try {
        const refreshToken = localStorage.getItem('refresh_token')
        const response = await axios.post('/api/v1/auth/refresh', {
          refresh_token: refreshToken,
        })

        // response 是原生 axios.post 的 AxiosResponse，response.data 是后端 body (TokenResponse)
        const { access_token, refresh_token: newRefreshToken } = response.data
        setAccessToken(access_token)
        if (newRefreshToken) {
          localStorage.setItem('refresh_token', newRefreshToken)
        }

        processQueue(null, access_token)

        // 重试原请求
        originalRequest.headers.Authorization = `Bearer ${access_token}`
        return client(originalRequest)
      } catch (refreshError) {
        processQueue(refreshError, null)
        clearAuthStorage()
        window.location.href = '/login'
        return Promise.reject(refreshError)
      } finally {
        isRefreshing = false
      }
    }

    // 其他错误处理
    // FastAPI 错误格式: { detail: "string" } 或 { detail: [{msg, loc, type}] }
    const errData = error.response?.data
    let errorMessage: string
    if (typeof errData?.detail === 'string') {
      errorMessage = errData.detail
    } else if (Array.isArray(errData?.detail)) {
      // 422 校验错误: 取所有 msg 拼接
      errorMessage = errData.detail.map((d: any) => d.msg).join('; ')
    } else {
      errorMessage = errData?.message || error.message || '网络错误，请稍后重试'
    }

    // 根据状态码显示不同提示
    switch (error.response?.status) {
      case 400:
        Message.error(`请求参数错误: ${errorMessage}`)
        break
      case 401:
        Message.error('登录已过期，请重新登录')
        clearAuthStorage()
        window.location.href = '/login'
        break
      case 403:
        Message.error('没有权限执行此操作')
        break
      case 404:
        Message.warning('请求的资源不存在')
        break
      case 422:
        Message.error(`参数校验失败: ${errorMessage}`)
        break
      case 429:
        Message.warning('操作过于频繁，请稍后再试')
        break
      case 500:
        Message.error('服务器内部错误')
        break
      default:
        if (error.code === 'ECONNABORTED') {
          Message.error('请求超时，请检查网络连接')
        } else {
          Message.error(errorMessage)
        }
    }

    return Promise.reject(error)
  }
)

// ==================== 封装常用请求方法 ====================

export const apiClient = {
  /**
   * GET请求
   */
  async get<T = any>(url: string, config?: AxiosRequestConfig): Promise<T> {
    return client.get(url, config)
  },

  /**
   * POST请求
   */
  async post<T = any>(
    url: string,
    data?: any,
    config?: AxiosRequestConfig
  ): Promise<T> {
    return client.post(url, data, config)
  },

  /**
   * PUT请求
   */
  async put<T = any>(
    url: string,
    data?: any,
    config?: AxiosRequestConfig
  ): Promise<T> {
    return client.put(url, data, config)
  },

  /**
   * DELETE请求
   */
  async delete<T = any>(url: string, config?: AxiosRequestConfig): Promise<T> {
    return client.delete(url, config)
  },

  /**
   * 文件上传
   */
  async upload<T = any>(
    url: string,
    file: File | Blob,
    onProgress?: (percent: number) => void
  ): Promise<T> {
    const formData = new FormData()
    formData.append('file', file)

    return client.post(url, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: (progressEvent) => {
        if (onProgress && progressEvent.total) {
          const percent = Math.round(
            (progressEvent.loaded * 100) / progressEvent.total
          )
          onProgress(percent)
        }
      },
    })
  },
}

export default client
