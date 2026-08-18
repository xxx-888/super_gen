/**
 * AdminSettingsPage - 系统设置
 *
 * 所有设置项保存后立即生效（后端 settings_service 带缓存，保存时清缓存）。
 */
import React, { useEffect, useState } from 'react'
import { Card, Button, Form, Input, Switch, InputNumber, Spin, Message, Typography, Divider } from '@arco-design/web-react'
import { IconSave } from '@arco-design/web-react/icon'
import { adminService } from '@/api/services'
import { refreshSiteConfig } from '@/hooks/useSiteConfig'

const { Title, Text } = Typography

const AdminSettingsPage: React.FC = () => {
  const [settings, setSettings] = useState<any>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testingFs, setTestingFs] = useState(false)
  const [fsTestResult, setFsTestResult] = useState<{ status: string; message: string } | null>(null)
  const [form] = Form.useForm()

  useEffect(() => {
    loadSettings()
  }, [])

  const loadSettings = async () => {
    setLoading(true)
    try {
      const data: any = await adminService.settings.get()
      setSettings(data || {})
      form.setFieldsValue(data || {})
    } catch {
      Message.warning('加载设置失败')
    } finally {
      setLoading(false)
    }
  }

  const handleTestFileServer = async () => {
    setTestingFs(true)
    setFsTestResult(null)
    try {
      // 用表单当前填写的值测试（未填则后端用已保存/环境变量配置）
      const values = form.getFieldsValue()
      const res: any = await adminService.settings.testFileServer({
        url: values.file_server_url || undefined,
        api_key: values.file_server_api_key || undefined,
      })
      setFsTestResult({ status: res?.status || 'failed', message: res?.message || '未知结果' })
    } catch (e: any) {
      setFsTestResult({ status: 'failed', message: e?.response?.data?.detail || e?.message || '测试请求失败' })
    } finally {
      setTestingFs(false)
    }
  }

  const handleSave = async () => {
    try {
      const values = await form.validate()
      setSaving(true)
      await adminService.settings.update(values)
      await refreshSiteConfig()  // 清缓存并重新拉取，站点名/描述等立即在所有页面生效
      Message.success('保存成功，设置已立即生效')
    } catch (err: any) {
      if (err?.errors) return
      Message.error(err?.response?.data?.detail || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ maxWidth: 700 }}>
      <Title heading={5} style={{ marginBottom: 20 }}>系统设置</Title>

      {loading ? <Card><Spin /></Card> : (
        <Form form={form} layout="vertical">
          {/* 基础设置 */}
          <Card title="基础设置" style={{ marginBottom: 16 }}>
            <Form.Item field="site_name" label="站点名称">
              <Input placeholder="SceneGen" />
            </Form.Item>
            <Form.Item field="site_description" label="站点描述">
              <Input.TextArea rows={2} placeholder="AI短剧生成平台" />
            </Form.Item>
          </Card>

          {/* 用户与注册 */}
          <Card title="用户与注册" style={{ marginBottom: 16 }}>
            <Form.Item field="allow_register" label="允许用户注册" triggerPropName="checked"
              extra={<Text type="secondary" style={{ fontSize: 12 }}>关闭后新用户只能由管理员在后台创建</Text>}>
              <Switch />
            </Form.Item>
            <Form.Item field="default_user_quota" label="新用户默认积分"
              extra={<Text type="secondary" style={{ fontSize: 12 }}>新注册用户自动赠送的积分数量</Text>}>
              <InputNumber min={0} max={100000} placeholder="100" style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item field="max_project_per_user" label="每用户最大项目数"
              extra={<Text type="secondary" style={{ fontSize: 12 }}>设为 0 表示不限制</Text>}>
              <InputNumber min={0} max={1000} placeholder="0" style={{ width: '100%' }} />
            </Form.Item>
          </Card>

          {/* 存储与日志 */}
          <Card title="存储与日志" style={{ marginBottom: 16 }}>
            <Form.Item field="storage_quota_gb" label="每用户存储配额（GB）"
              extra={<Text type="secondary" style={{ fontSize: 12 }}>生成视频/图片的本地存储上限</Text>}>
              <InputNumber min={1} max={10000} placeholder="10" style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item field="enable_audit_log" label="启用审计日志" triggerPropName="checked"
              extra={<Text type="secondary" style={{ fontSize: 12 }}>记录所有 AI 模型调用（角色/场景/视频生成等）到任务队列</Text>}>
              <Switch />
            </Form.Item>
          </Card>

          {/* 任务与生成 */}
          <Card title="任务与生成" style={{ marginBottom: 16 }}>
            <Form.Item field="task_poll_timeout_seconds" label="任务查询超时时间（秒）"
              extra={<Text type="secondary" style={{ fontSize: 12 }}>
                生成任务（MiniMax H3 视频等）的轮询超时上限，建议 ≥ 600 秒。模型单独配置的值仍优先生效
              </Text>}>
              <InputNumber min={60} max={3600} placeholder="600" style={{ width: '100%' }} />
            </Form.Item>
          </Card>

          {/* 文件服务器 */}
          <Card title="文件服务器" style={{ marginBottom: 16 }}
            extra={
              <Button size="small" loading={testingFs} onClick={handleTestFileServer}>
                测试连接
              </Button>
            }>
            <Form.Item field="file_server_url" label="文件服务器地址"
              extra={<Text type="secondary" style={{ fontSize: 12 }}>
                独立部署的文件服务（fileserver/）公网地址，如 http://1.2.3.4:9000。
                配置后上传自动转传云端（双写开启时本地同步留一份）；<b>清空并保存 = 停用云端，全部本地存储</b>；
                从未设置时使用服务器 .env 中的 FILE_SERVER_URL 兜底
              </Text>}>
              <Input placeholder="http://186.241.125.144:9000" allowClear />
            </Form.Item>
            <Form.Item field="file_server_api_key" label="文件服务器 API Key"
              extra={<Text type="secondary" style={{ fontSize: 12 }}>
                上传/删除鉴权密钥（文件直链下载为公开访问，渠道拉取不带鉴权）；与服务器端 FILE_SERVER_API_KEY 一致
              </Text>}>
              <Input.Password placeholder="sk-..." allowClear />
            </Form.Item>
            <Form.Item field="file_server_dual_write" label="双写备份（本地 + 云端各存一份）" triggerPropName="checked"
              initialValue={true}
              extra={<Text type="secondary" style={{ fontSize: 12 }}>
                开启（推荐）：上传的图片/视频/音频转传云端的同时在本地 uploads 另存一份。
                视频音频的记录地址用云端直链（生成渠道需公网下载），图片用本地地址（模型读取更快）；
                关闭后云端为唯一存储（省本地磁盘，注意备份服务器数据）
              </Text>}>
              <Switch />
            </Form.Item>
            {fsTestResult && (
              <div style={{
                fontSize: 12, padding: '6px 10px', borderRadius: 6,
                background: fsTestResult.status === 'success' ? 'rgb(var(--success-1))' : 'rgb(var(--danger-1))',
                color: fsTestResult.status === 'success' ? 'rgb(var(--success-6))' : 'rgb(var(--danger-6))',
              }}>
                {fsTestResult.status === 'success' ? '✓ ' : '✗ '}{fsTestResult.message}
              </div>
            )}
          </Card>

          <Button type="primary" icon={<IconSave />} loading={saving} onClick={handleSave} size="large">
            保存设置
          </Button>
        </Form>
      )}
    </div>
  )
}

export default AdminSettingsPage
