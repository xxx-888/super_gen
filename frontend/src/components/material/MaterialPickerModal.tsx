/**
 * MaterialPickerModal - 通用素材库选择器
 *
 * 用途：在片段管理/资源管理页添加角色/场景/物品时，弹出此选择器，
 *      从企业素材库查找已有素材 → 选中后自动同步到项目资源并回填。
 *      找不到时支持「新建项目资源」内嵌表单。
 *
 * 三套命名映射（必须处理）：
 *   素材库 class_type  →  sync target_type  →  GenElementInput.type
 *   character          →  character         →  character
 *   scene              →  scene_bg          →  scene
 *   prop               →  prop              →  prop
 */
import React, { useCallback, useEffect, useState } from 'react'
import {
  Modal, Input, Spin, Empty, Grid, Card, Tag, Button, Space, Message,
  Typography, Tabs, Form, Radio,
} from '@arco-design/web-react'
import {
  IconSearch, IconImage, IconPlus, IconRefresh, IconUser, IconHome, IconTool,
} from '@arco-design/web-react/icon'
import { materialLibraryService, resourceService } from '@/api/services'
import { useTeamStore } from '@/stores'
import type { TeamMaterial } from '@/types'

const { Text } = Typography
const { Row, Col } = Grid
const { TabPane } = Tabs

/** 业务类型 → 素材库 class_type */
const TYPE_TO_CLASS: Record<string, string> = {
  character: 'character',
  scene: 'scene',
  prop: 'prop',
}
/** 素材库 class_type → sync target_type */
const CLASS_TO_TARGET: Record<string, string> = {
  character: 'character',
  scene: 'scene_bg',
  prop: 'prop',
}
/** 业务类型 → 中文标签 */
const TYPE_LABELS: Record<string, string> = {
  character: '角色',
  scene: '场景',
  prop: '物品',
}
/** 业务类型 → 图标 */
const TYPE_ICON: Record<string, React.ReactNode> = {
  character: <IconUser />,
  scene: <IconHome />,
  prop: <IconTool />,
}

/** 选择结果：包含同步后的项目资源 id，便于回填到 element.resource_id */
export interface MaterialPickResult {
  /** 项目资源 id（sync 后或 create 后） */
  resource_id: string
  /** 素材库原始 id（来自库选择时存在；新建时为 null） */
  material_id: string | null
  name: string
  image_url?: string
  /** 业务类型（character/scene/prop） */
  type: string
}

export interface MaterialPickerModalProps {
  visible: boolean
  /** 业务类型：character / scene / prop */
  classType: 'character' | 'scene' | 'prop'
  projectId: string
  onSelect: (result: MaterialPickResult) => void
  onCancel: () => void
}

const MaterialPickerModal: React.FC<MaterialPickerModalProps> = ({
  visible, classType, projectId, onSelect, onCancel,
}) => {
  const { currentOrg } = useTeamStore()
  const orgId = currentOrg?.id
  const matSvc = React.useMemo(() => (orgId ? materialLibraryService(orgId) : null), [orgId])

  const [tab, setTab] = useState<'library' | 'create'>('library')
  const [materials, setMaterials] = useState<TeamMaterial[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [syncing, setSyncing] = useState<string | null>(null) // 正在同步的 material id

  // 新建表单
  const [createForm] = Form.useForm()
  const [creating, setCreating] = useState(false)

  const loadMaterials = useCallback(async () => {
    if (!matSvc) return
    setLoading(true)
    try {
      const res: any = await matSvc.list({
        category: 'image',
        class_type: TYPE_TO_CLASS[classType],
        search: search.trim() || undefined,
        page_size: 60,
      })
      const list = Array.isArray(res) ? res : (res?.data?.items ?? res?.data ?? [])
      setMaterials(list)
    } catch {
      // 拦截器已提示
    } finally {
      setLoading(false)
    }
  }, [matSvc, classType, search])

  useEffect(() => {
    if (visible) {
      setTab('library')
      setSearch('')
    }
  }, [visible, classType])

  // 搜索防抖：search 变化时 350ms 后重新加载
  useEffect(() => {
    if (!visible || !matSvc) return
    const timer = setTimeout(() => { loadMaterials() }, 350)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, classType, visible, matSvc])

  /** 同步素材到项目资源（幂等：已同步则按 url 在项目资源里找回 id） */
  const handlePick = async (m: TeamMaterial) => {
    if (!matSvc) {
      Message.warning('请先选择团队')
      return
    }
    const targetType = CLASS_TO_TARGET[classType]
    setSyncing(m.id)
    try {
      const res: any = await matSvc.sync(m.id, projectId, targetType)
      const r = res?.data ?? res
      Message.success(`已导入到项目资源：${r.target_name || m.name}`)
      onSelect({
        resource_id: r.target_id,
        material_id: m.id,
        name: m.name,
        image_url: m.url,
        type: classType,
      })
    } catch (e: any) {
      // 幂等性：已同步过 → 尝试按 url 在项目资源里找回已存在的 id
      const msg = e?.response?.data?.detail || e?.message || ''
      if (msg.includes('already synced') || msg.includes('已同步')) {
        const existingId = await findExistingResourceId(m.url)
        if (existingId) {
          Message.info('该素材已导入过，直接使用')
          onSelect({
            resource_id: existingId,
            material_id: m.id,
            name: m.name,
            image_url: m.url,
            type: classType,
          })
          return
        }
        Message.warning('该素材已同步过，但未能定位项目资源')
      } else {
        Message.error(msg || '导入失败')
      }
    } finally {
      setSyncing(null)
    }
  }

  /** 按 url 在对应项目资源列表里找回已同步的资源 id（幂等回退路径） */
  const findExistingResourceId = async (url: string): Promise<string | null> => {
    try {
      let list: any
      if (classType === 'character') list = await resourceService.characters.list(projectId)
      else if (classType === 'scene') list = await resourceService.sceneBg.list(projectId)
      else if (classType === 'prop') list = await resourceService.props.list(projectId)
      const arr: any[] = Array.isArray(list) ? list : (list?.data ?? [])
      const hit = arr.find((r: any) => r.image_url === url || r.url === url)
      return hit?.id ?? null
    } catch {
      return null
    }
  }

  /** 新建项目资源（直接建到项目，不经素材库） */
  const handleCreate = async () => {
    try {
      const values = await createForm.validate()
      setCreating(true)
      let res: any
      if (classType === 'character') {
        res = await resourceService.characters.create(projectId, {
          name: values.name,
          description: values.description,
          appearance_prompt: values.prompt,
        })
      } else if (classType === 'scene') {
        res = await resourceService.sceneBg.create(projectId, {
          name: values.name,
          description: values.description,
          prompt: values.prompt,
        })
      } else {
        res = await resourceService.props.create(projectId, {
          name: values.name,
          description: values.description,
          prompt: values.prompt,
        })
      }
      const r = res?.data ?? res
      Message.success(`已新建${TYPE_LABELS[classType]}：${r.name}`)
      onSelect({
        resource_id: r.id,
        material_id: null,
        name: r.name,
        image_url: r.image_url,
        type: classType,
      })
      createForm.resetFields()
    } catch (e: any) {
      if (e?.errors) return // 表单校验失败
      Message.error(e?.message || '创建失败')
    } finally {
      setCreating(false)
    }
  }

  return (
    <Modal
      title={`从素材库选择 ${TYPE_LABELS[classType]}`}
      visible={visible}
      onCancel={onCancel}
      footer={null}
      style={{ width: 760 }}
    >
      {!orgId ? (
        <Empty description="请先在顶部切换到某个团队" style={{ padding: 40 }} />
      ) : (
        <Tabs activeTab={tab} onChange={(v) => setTab(v as 'library' | 'create')}>
          {/* Tab: 素材库选择 */}
          <TabPane
            key="library"
            tab={<span><IconImage /> 素材库 ({materials.length})</span>}
          >
            {/* 搜索栏 */}
            <Space style={{ marginBottom: 12, width: '100%', justifyContent: 'space-between' }}>
              <Input
                placeholder={`搜索${TYPE_LABELS[classType]}名称（输入即搜）`}
                value={search}
                onChange={(v) => setSearch(v)}
                onPressEnter={loadMaterials}
                style={{ width: 280 }}
                allowClear
                prefix={<IconSearch />}
              />
              <Button icon={<IconRefresh />} onClick={loadMaterials} size="small">刷新</Button>
            </Space>

            {/* 列表 */}
            {loading ? (
              <Spin dot style={{ display: 'block', margin: '40px auto' }} />
            ) : materials.length === 0 ? (
              <Empty
                description={
                  <span>
                    素材库中没有匹配的{TYPE_LABELS[classType]}
                    <br />
                    <Button type="text" size="small" icon={<IconPlus />} onClick={() => setTab('create')}>
                      直接新建一个
                    </Button>
                  </span>
                }
                style={{ padding: 40 }}
              />
            ) : (
              <Row gutter={[8, 8]} style={{ maxHeight: 420, overflowY: 'auto', padding: 4 }}>
                {materials.map((m) => (
                  <Col key={m.id} span={6}>
                    <Card
                      size="small"
                      hoverable
                      onClick={() => handlePick(m)}
                      bodyStyle={{ padding: 6 }}
                      style={syncing === m.id ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
                    >
                      <div style={{
                        aspectRatio: '1/1', background: 'var(--color-fill-3)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        overflow: 'hidden', borderRadius: 4,
                      }}>
                        {m.thumbnail_url || m.url ? (
                          <img
                            src={m.thumbnail_url || m.url}
                            alt={m.name}
                            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          />
                        ) : (
                          <IconImage style={{ fontSize: 24, color: 'var(--color-text-3)' }} />
                        )}
                        {syncing === m.id && (
                          <div style={{
                            position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                          }}>
                            <Spin size={20} />
                          </div>
                        )}
                      </div>
                      <Text style={{
                        display: 'block', fontSize: 12, marginTop: 4, textAlign: 'center',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {m.name}
                      </Text>
                    </Card>
                  </Col>
                ))}
              </Row>
            )}
            <div style={{ marginTop: 8, color: 'var(--color-text-3)', fontSize: 12 }}>
              <Tag size="small" color="arcoblue">提示</Tag>
              点击素材即自动同步到项目资源并选用，同一素材重复导入会自动复用。
            </div>
          </TabPane>

          {/* Tab: 新建项目资源 */}
          <TabPane
            key="create"
            tab={<span><IconPlus /> 新建{TYPE_LABELS[classType]}</span>}
          >
            <Form form={createForm} layout="vertical" style={{ marginTop: 8 }}>
              <Form.Item
                field="name"
                label={`${TYPE_LABELS[classType]}名称`}
                rules={[{ required: true, message: '请输入名称' }]}
              >
                <Input placeholder={`例如：${classType === 'character' ? '沈如姬' : classType === 'scene' ? '咖啡厅' : '信件'}`} />
              </Form.Item>
              <Form.Item field="prompt" label={classType === 'character' ? '外貌描述' : '画面提示词'}>
                <Input.TextArea
                  placeholder={classType === 'character'
                    ? '描述角色外貌、服饰、发型等特征，用于 AI 生图'
                    : '描述场景/物品的画面元素、风格、光线等'}
                  autoSize={{ minRows: 3, maxRows: 6 }}
                />
              </Form.Item>
              <Form.Item field="description" label="备注（可选）">
                <Input placeholder="补充说明" />
              </Form.Item>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <Button onClick={() => setTab('library')}>返回素材库</Button>
                <Button type="primary" loading={creating} onClick={handleCreate}>
                  新建并选用
                </Button>
              </div>
            </Form>
          </TabPane>
        </Tabs>
      )}
    </Modal>
  )
}

export default MaterialPickerModal
