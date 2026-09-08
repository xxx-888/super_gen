/**
 * TeamPermissionGroupsPage - 权限组管理 (M2)
 *
 * 权限组是「素材库权限模板」：编辑好六项权限后，一键应用到成员或成员组，
 * 批量写入素材库权限矩阵并立即生效（素材库接口按矩阵拦截）。
 */
import React, { useEffect, useState, useCallback } from 'react'
import { Card, Spin, Table, Typography, Button, Space, Tag, Modal, Form, Input, Select, Switch, Message, Popconfirm, Empty, Alert } from '@arco-design/web-react'
import { IconPlus, IconRefresh, IconEdit, IconDelete, IconExport } from '@arco-design/web-react/icon'
import { teamService } from '@/api/services'
import { useTeamStore } from '@/stores'

const { Title, Text } = Typography

// 与素材库权限矩阵六项一一对应（view→can_view …）
const PERM_LABELS: Record<string, string> = {
  view: '查看', upload: '上传', download: '下载', edit: '编辑', delete: '删除', invoke: '引用',
}

const TeamPermissionGroupsPage: React.FC = () => {
  const { currentOrg } = useTeamStore()
  const orgId = currentOrg?.id
  const [groups, setGroups] = useState<any[]>([])
  const [members, setMembers] = useState<any[]>([])
  const [memberGroups, setMemberGroups] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [modalVisible, setModalVisible] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form] = Form.useForm()

  // 应用弹窗
  const [applyTarget, setApplyTarget] = useState<any>(null)
  const [applyForm] = Form.useForm()
  const [applying, setApplying] = useState(false)

  const load = useCallback(async () => {
    if (!orgId) return
    setLoading(true)
    try {
      const [gRes, mRes, mgRes]: any = await Promise.all([
        teamService.permissionGroups(orgId).list(),
        teamService.members.list(orgId),
        teamService.memberGroups(orgId).list(),
      ])
      setGroups(Array.isArray(gRes) ? gRes : (gRes?.data ?? []))
      setMembers(Array.isArray(mRes) ? mRes : (mRes?.data ?? []))
      setMemberGroups(Array.isArray(mgRes) ? mgRes : (mgRes?.data ?? []))
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [orgId])

  useEffect(() => { load() }, [load])

  const handleSubmit = async () => {
    try {
      const v = await form.validate()
      const perms: Record<string, boolean> = {}
      Object.keys(PERM_LABELS).forEach((k) => { perms[k] = !!v[`perm_${k}`] })
      const payload = { name: v.name, description: v.description, permissions: perms }
      if (editId) {
        await teamService.permissionGroups(orgId).update(editId, payload)
        Message.success('已更新')
      } else {
        await teamService.permissionGroups(orgId).create(payload)
        Message.success('已创建')
      }
      setModalVisible(false); setEditId(null); form.resetFields(); load()
    } catch (e: any) { if (e?.errorFields) return }
  }

  const handleDelete = async (id: string) => {
    try {
      await teamService.permissionGroups(orgId).delete(id)
      Message.success('已删除'); load()
    } catch { Message.error('删除失败') }
  }

  const handleApply = async () => {
    if (!applyTarget) return
    try {
      const v = await applyForm.validate()
      setApplying(true)
      const res: any = await teamService.permissionGroups(orgId).apply(applyTarget.id, {
        user_ids: v.user_ids || [],
        member_group_ids: v.member_group_ids || [],
      })
      const n = res?.data?.applied ?? res?.applied
      Message.success(`已应用到 ${n ?? 0} 位成员的素材库权限，立即生效`)
      setApplyTarget(null); applyForm.resetFields()
    } catch (e: any) {
      if (e?.errorFields) return
      Message.error(e?.response?.data?.detail?.message || e?.message || '应用失败')
    } finally { setApplying(false) }
  }

  const columns = [
    { title: '权限组名称', dataIndex: 'name', render: (v: string) => <b>{v}</b> },
    { title: '描述', dataIndex: 'description', render: (v: string) => v || '-' },
    {
      title: '权限', dataIndex: 'permissions',
      render: (perms: Record<string, boolean>) => (
        <Space wrap>
          {Object.entries(perms || {}).filter(([, v]) => v).map(([k]) => (
            <Tag key={k} color="arcoblue">{PERM_LABELS[k] || k}</Tag>
          ))}
          {!Object.values(perms || {}).some(Boolean) && <Text type="secondary">无</Text>}
        </Space>
      ),
    },
    {
      title: '创建时间', dataIndex: 'created_at', width: 150,
      render: (v: string) => v ? v.replace('T', ' ').slice(0, 16) : '-',
    },
    {
      title: '操作', key: 'action', width: 240,
      render: (_v: any, r: any) => (
        <Space>
          <Button size="mini" type="primary" icon={<IconExport />} onClick={() => { setApplyTarget(r); applyForm.resetFields() }}>
            应用到成员
          </Button>
          <Button size="mini" icon={<IconEdit />} onClick={() => {
            setEditId(r.id); setModalVisible(true)
            const fv: any = { name: r.name, description: r.description }
            Object.keys(PERM_LABELS).forEach((k) => { fv[`perm_${k}`] = !!r.permissions?.[k] })
            form.setFieldsValue(fv)
          }}>编辑</Button>
          <Popconfirm title="确定删除?" onOk={() => handleDelete(r.id)}>
            <Button size="mini" icon={<IconDelete />} status="danger">删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <Title heading={5} style={{ marginBottom: 20 }}>权限组管理</Title>

      <Alert
        type="info"
        style={{ marginBottom: 16 }}
        content={
          <div>
            <Text bold>权限组 = 素材库权限模板，应用后立即生效</Text>
            <div style={{ marginTop: 4, fontSize: 13 }}>
              六项权限作用于企业素材库（查看/上传/下载/编辑/删除/引用）。编辑好模板后点「应用到成员」，
              批量写入成员的素材库权限矩阵——素材库接口会按矩阵实时拦截，未授权操作返回 403。
            </div>
          </div>
        }
      />

      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <Text type="secondary">共 {groups.length} 个权限组</Text>
          <Space>
            <Button icon={<IconRefresh />} onClick={load}>刷新</Button>
            <Button type="primary" icon={<IconPlus />} onClick={() => { setEditId(null); form.resetFields(); setModalVisible(true) }}>新建权限组</Button>
          </Space>
        </div>
        {loading ? <Spin dot style={{ display: 'block', margin: '20px auto' }} /> :
         groups.length === 0 ? <Empty description="暂无权限组" /> :
         <Table columns={columns} data={groups} rowKey="id" pagination={{ pageSize: 15 }} size="small" />
        }
      </Card>

      <Modal
        title={editId ? '编辑权限组' : '新建权限组'} visible={modalVisible}
        onCancel={() => { setModalVisible(false); setEditId(null) }} onOk={handleSubmit}
        okText="保存" cancelText="取消" style={{ width: 480 }}
      >
        <Form form={form} layout="vertical">
          <Form.Item field="name" label="权限组名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="如：只能查看" />
          </Form.Item>
          <Form.Item field="description" label="描述">
            <Input placeholder="可选" />
          </Form.Item>
          <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>权限项（作用于企业素材库）</Text>
          {Object.entries(PERM_LABELS).map(([k, label]) => (
            <Form.Item key={k} field={`perm_${k}`} label={label} triggerPropName="checked" style={{ marginBottom: 8 }}>
              <Switch />
            </Form.Item>
          ))}
        </Form>
      </Modal>

      {/* 应用到成员 */}
      <Modal
        title={`应用权限组「${applyTarget?.name || ''}」`}
        visible={!!applyTarget}
        onCancel={() => { setApplyTarget(null); applyForm.resetFields() }}
        onOk={handleApply}
        confirmLoading={applying}
        okText="应用并生效" cancelText="取消"
        style={{ width: 480 }}
      >
        {applyTarget && (
          <>
            <div style={{ marginBottom: 12 }}>
              将把以下权限写入所选成员的素材库权限矩阵：
              <Space wrap style={{ marginTop: 6 }}>
                {Object.entries(applyTarget.permissions || {}).filter(([, v]) => v).map(([k]) => (
                  <Tag key={k} color="green">{PERM_LABELS[k] || k}</Tag>
                ))}
                {!Object.values(applyTarget.permissions || {}).some(Boolean) && (
                  <Text type="secondary">无任何权限（应用后成员将被限制为仅默认查看级别）</Text>
                )}
              </Space>
            </div>
            <Form form={applyForm} layout="vertical">
              <Form.Item field="member_group_ids" label="按成员组应用（可选）">
                <Select
                  mode="multiple" placeholder="选择成员组，自动展开组内全部成员"
                  options={memberGroups.map((g: any) => ({ label: `${g.name}（${g.member_count ?? (g.member_ids || []).length} 人）`, value: g.id }))}
                />
              </Form.Item>
              <Form.Item field="user_ids" label="直接选择成员（可选，与成员组取并集）">
                <Select
                  mode="multiple" placeholder="选择成员"
                  options={members.filter((m: any) => m.role === 'member').map((m: any) => ({
                    label: m.nickname || m.email,
                    value: m.user_id,
                  }))}
                />
              </Form.Item>
            </Form>
          </>
        )}
      </Modal>
    </div>
  )
}

export default TeamPermissionGroupsPage
