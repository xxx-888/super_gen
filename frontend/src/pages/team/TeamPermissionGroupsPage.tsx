/**
 * TeamPermissionGroupsPage - 权限组管理 (M2)
 */
import React, { useEffect, useState, useCallback } from 'react'
import { Card, Spin, Table, Typography, Button, Space, Tag, Modal, Form, Input, Switch, Message, Popconfirm, Empty } from '@arco-design/web-react'
import { IconPlus, IconRefresh, IconEdit, IconDelete } from '@arco-design/web-react/icon'
import { teamService } from '@/api/services'
import { useTeamStore } from '@/stores'

const { Title, Text } = Typography

const PERM_LABELS: Record<string, string> = {
  view: '查看', edit: '编辑', delete: '删除', download: '下载', upload: '上传',
}

const TeamPermissionGroupsPage: React.FC = () => {
  const { currentOrg } = useTeamStore()
  const orgId = currentOrg?.id
  const [groups, setGroups] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [modalVisible, setModalVisible] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form] = Form.useForm()

  const load = useCallback(async () => {
    if (!orgId) return
    setLoading(true)
    try {
      const res: any = await teamService.permissionGroups(orgId).list()
      setGroups(Array.isArray(res) ? res : (res?.data ?? []))
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
      title: '创建时间', dataIndex: 'created_at', width: 170,
      render: (v: string) => v ? v.replace('T', ' ').slice(0, 16) : '-',
    },
    {
      title: '操作', key: 'action', width: 160,
      render: (_v: any, r: any) => (
        <Space>
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
            <Input placeholder="如：编辑组" />
          </Form.Item>
          <Form.Item field="description" label="描述">
            <Input placeholder="可选" />
          </Form.Item>
          <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>权限项</Text>
          {Object.entries(PERM_LABELS).map(([k, label]) => (
            <Form.Item key={k} field={`perm_${k}`} label={label} triggerPropName="checked" style={{ marginBottom: 8 }}>
              <Switch />
            </Form.Item>
          ))}
        </Form>
      </Modal>
    </div>
  )
}

export default TeamPermissionGroupsPage
