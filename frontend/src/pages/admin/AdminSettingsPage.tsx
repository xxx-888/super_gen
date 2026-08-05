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

  const handleSave = async () => {
    try {
      const values = await form.validate()
      setSaving(true)
      await adminService.settings.update(values)
      refreshSiteConfig()  // 清除前端缓存，刷新页面后站点名/描述立即更新
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

          <Button type="primary" icon={<IconSave />} loading={saving} onClick={handleSave} size="large">
            保存设置
          </Button>
        </Form>
      )}
    </div>
  )
}

export default AdminSettingsPage
