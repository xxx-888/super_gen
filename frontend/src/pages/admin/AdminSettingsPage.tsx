/**
 * AdminSettingsPage - 系统设置
 *
 * 所有设置项保存后立即生效（后端 settings_service 带缓存，保存时清缓存）。
 * 底部附：存储统计（本地/文件服务器 + 孤立文件扫描清理）、运行日志（操作审计）。
 */
import React, { useEffect, useState } from 'react'
import {
  Card, Button, Form, Input, Switch, InputNumber, Spin, Message, Typography,
  Table, Tag, Space, Select, Popconfirm, Collapse, Statistic, Grid,
} from '@arco-design/web-react'
import { IconSave, IconRefresh, IconSearch, IconDelete } from '@arco-design/web-react/icon'
import { adminService } from '@/api/services'
import { refreshSiteConfig } from '@/hooks/useSiteConfig'

const { Title, Text } = Typography
const { Row, Col } = Grid

/** 操作日志动作 → 中文标签 */
const LOG_ACTION_MAP: Record<string, { label: string; color: string }> = {
  edit: { label: '编辑成员', color: 'arcoblue' },
  reset_password: { label: '重置密码', color: 'orange' },
  disable: { label: '禁用成员', color: 'red' },
  enable: { label: '启用成员', color: 'green' },
  role_change: { label: '角色变更', color: 'purple' },
  invite: { label: '邀请成员', color: 'cyan' },
  credits_allocate: { label: '积分分配', color: 'gold' },
}

const fmtMb = (v: number | null | undefined) => {
  if (v == null) return '-'
  if (v >= 1024) return `${(v / 1024).toFixed(2)} GB`
  return `${v.toFixed(1)} MB`
}

const AdminSettingsPage: React.FC = () => {
  const [settings, setSettings] = useState<any>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testingFs, setTestingFs] = useState(false)
  const [fsTestResult, setFsTestResult] = useState<{ status: string; message: string } | null>(null)
  const [form] = Form.useForm()

  // ---- 存储统计 / 孤立文件 ----
  const [storageStats, setStorageStats] = useState<any>(null)
  const [storageLoading, setStorageLoading] = useState(false)
  const [scanResult, setScanResult] = useState<any>(null)
  const [scanning, setScanning] = useState(false)
  const [cleaning, setCleaning] = useState(false)

  // ---- 运行日志 ----
  const [logs, setLogs] = useState<any[]>([])
  const [logsLoading, setLogsLoading] = useState(false)
  const [logAction, setLogAction] = useState<string | undefined>(undefined)

  useEffect(() => {
    loadSettings()
    loadStorageStats()
    loadLogs()
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

  const loadStorageStats = async () => {
    setStorageLoading(true)
    try {
      const data: any = await adminService.storageStats()
      setStorageStats(data || {})
    } catch { /* 拦截器提示 */ } finally { setStorageLoading(false) }
  }

  const handleScanOrphans = async () => {
    setScanning(true)
    setScanResult(null)
    try {
      const res: any = await adminService.storageCleanup(true)
      setScanResult(res)
    } catch { /* 拦截器提示 */ } finally { setScanning(false) }
  }

  const handleCleanup = async () => {
    setCleaning(true)
    try {
      const res: any = await adminService.storageCleanup(false)
      Message.success(`已清理 ${res?.deleted ?? 0} 个孤立文件，释放 ${fmtMb((res?.total_size_mb) || 0)}`)
      setScanResult(null)
      loadStorageStats()
    } catch { /* 拦截器提示 */ } finally { setCleaning(false) }
  }

  const loadLogs = async (action?: string) => {
    setLogsLoading(true)
    try {
      const data: any = await adminService.logs({ action, limit: 100 })
      setLogs(Array.isArray(data) ? data : [])
    } catch { /* 拦截器提示 */ } finally { setLogsLoading(false) }
  }

  return (
    <div style={{ maxWidth: 900 }}>
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

      {/* 存储统计 */}
      <Card
        title="存储统计"
        style={{ marginBottom: 16, marginTop: 24 }}
        extra={<Button size="small" icon={<IconRefresh />} loading={storageLoading} onClick={loadStorageStats}>刷新</Button>}
      >
        <Row gutter={16}>
          {['image', 'video', 'audio'].map((cat) => {
            const labelMap: Record<string, string> = { image: '图片', video: '视频', audio: '音频' }
            const s = storageStats?.local?.[cat]
            return (
              <Col key={cat} span={6}>
                <Statistic
                  title={`${labelMap[cat]}（${s?.count ?? 0} 个文件）`}
                  value={fmtMb(s?.size_mb ?? 0)}
                  styleValue={{ fontSize: 20 }}
                />
              </Col>
            )
          })}
          <Col span={6}>
            <Statistic title="本地合计" value={fmtMb(storageStats?.local?.total_size_mb ?? 0)} styleValue={{ fontSize: 20, fontWeight: 600 }} />
          </Col>
        </Row>
        {storageStats?.file_server && (
          <div style={{ marginTop: 12, fontSize: 12 }}>
            <Space size={6} wrap>
              <Tag color={storageStats.file_server.configured ? 'green' : 'gray'}>
                文件服务器：{storageStats.file_server.configured ? '已配置' : '未配置'}
              </Tag>
              {storageStats.file_server.stats && (
                <Tag color="cyan">
                  {storageStats.file_server.stats.total_files ?? storageStats.file_server.stats.file_count ?? '-'} 个文件 / {fmtMb(storageStats.file_server.stats.total_size_mb ?? storageStats.file_server.stats.used_mb)}
                </Tag>
              )}
              {storageStats.file_server.error && <Tag color="red">统计失败：{storageStats.file_server.error}</Tag>}
            </Space>
          </div>
        )}
        <Space style={{ marginTop: 16 }}>
          <Button icon={<IconSearch />} loading={scanning} onClick={handleScanOrphans}>扫描孤立文件</Button>
          {scanResult && scanResult.orphan_count > 0 && (
            <Popconfirm
              title={`确认删除 ${scanResult.orphan_count} 个孤立文件（共 ${fmtMb(scanResult.total_size_mb)}）？`}
              content="孤立 = 无任何数据库引用的本地文件（任务输出/素材/画布/作品等全来源比对），刚生成不足 24 小时的文件不会列入。删除不可恢复。"
              onOk={handleCleanup}
            >
              <Button status="danger" icon={<IconDelete />} loading={cleaning}>执行清理</Button>
            </Popconfirm>
          )}
        </Space>
        {scanResult && (
          <div style={{ marginTop: 12 }}>
            {scanResult.orphan_count === 0
              ? <Text type="success">✓ 未发现孤立文件</Text>
              : (
                <Collapse>
                  <Collapse.Item name="orphans" header={`发现 ${scanResult.orphan_count} 个孤立文件，共 ${fmtMb(scanResult.total_size_mb)}（点击展开清单，最多显示 500 条）`}>
                    <div style={{ maxHeight: 240, overflow: 'auto', fontSize: 12 }}>
                      {(scanResult.files || []).map((f: any, i: number) => (
                        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--color-fill-2)', padding: '2px 0' }}>
                          <Text copyable style={{ fontSize: 12 }}>{f.path}</Text>
                          <Text type="secondary">{fmtMb(f.size_mb)}</Text>
                        </div>
                      ))}
                    </div>
                  </Collapse.Item>
                </Collapse>
              )}
          </div>
        )}
      </Card>

      {/* 运行日志（操作审计） */}
      <Card
        title="运行日志（操作审计）"
        extra={
          <Space>
            <Select
              placeholder="全部操作"
              style={{ width: 140 }}
              allowClear
              value={logAction}
              onChange={(v) => { setLogAction(v); loadLogs(v) }}
            >
              {Object.entries(LOG_ACTION_MAP).map(([k, v]) => (
                <Select.Option key={k} value={k}>{v.label}</Select.Option>
              ))}
            </Select>
            <Button size="small" icon={<IconRefresh />} loading={logsLoading} onClick={() => loadLogs(logAction)}>刷新</Button>
          </Space>
        }
      >
        <Table
          size="small"
          rowKey="id"
          data={logs}
          loading={logsLoading}
          pagination={{ pageSize: 10, showTotal: true }}
          noDataElement="暂无操作日志"
          columns={[
            {
              title: '时间', dataIndex: 'created_at', width: 160,
              render: (v: string) => v ? <Text type="secondary" style={{ fontSize: 12 }}>{new Date(v).toLocaleString('zh-CN')}</Text> : '-',
            },
            {
              title: '操作', dataIndex: 'action', width: 110,
              render: (v: string) => {
                const m = LOG_ACTION_MAP[v]
                return m ? <Tag color={m.color}>{m.label}</Tag> : <Tag>{v}</Tag>
              },
            },
            {
              title: '操作人', dataIndex: 'operator', width: 170, ellipsis: true,
              render: (v: any) => v ? `${v.nickname || ''} ${v.email ? `(${v.email})` : ''}` : '-',
            },
            {
              title: '对象成员', dataIndex: 'target_user', width: 170, ellipsis: true,
              render: (v: any) => v ? `${v.nickname || ''} ${v.email ? `(${v.email})` : ''}` : '-',
            },
            { title: '详情', dataIndex: 'detail', ellipsis: true },
          ]}
        />
      </Card>
    </div>
  )
}

export default AdminSettingsPage
