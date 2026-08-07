/**
 * TeamMemberGroupsPage - 成员组管理 (M2)
 */
import React, { useEffect, useState, useCallback } from 'react'
import { Card, Spin, Table, Typography, Button, Space, Modal, Form, Input, Message, Popconfirm, Empty } from '@arco-design/web-react'
import { IconPlus, IconRefresh, IconEdit, IconDelete } from '@arco-design/web-react/icon'
import { teamService } from '@/api/services'
import { useTeamStore } from '@/stores'

const { Title, Text } = Typography

const TeamMemberGroupsPage: React.FC = () => {
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
      const res: any = await teamService.memberGroups(orgId).list()
      setGroups(Array.isArray(res) ? res : (res?.data ?? []))
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [orgId])

  useEffect(() => { load() }, [load])

  const handleSubmit = async () => {
    try {
      const v = await form.validate()
      if (editId) {
        await teamService.memberGroups(orgId).update(editId, v)
        Message.success('已更新')
      } else {
        await teamService.memberGroups(orgId).create(v)
        Message.success('已创建')
      }
      setModalVisible(false); setEditId(null); form.resetFields(); load()
    } catch (e: any) { if (e?.errorFields) return }
  }

  const handleDelete = async (id: string) => {
    try {
      await teamService.memberGroups(orgId).delete(id)
      Message.success('已删除')
      load()
    } catch { Message.error('删除失败') }
  }

  const columns = [
    { title: '成员组名称', dataIndex: 'name', render: (v: string) => <b>{v}</b> },
    { title: '组长', dataIndex: 'leader_name', render: (v: string) => v || '-' },
    { title: '成员数', dataIndex: 'member_count', width: 100 },
    { title: '描述', dataIndex: 'description', render: (v: string) => v || '-' },
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
            form.setFieldsValue({ name: r.name, description: r.description, leader_id: r.leader_id })
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
      <Title heading={5} style={{ marginBottom: 20 }}>成员组管理</Title>
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <Text type="secondary">共 {groups.length} 个成员组</Text>
          <Space>
            <Button icon={<IconRefresh />} onClick={load}>刷新</Button>
            <Button type="primary" icon={<IconPlus />} onClick={() => { setEditId(null); form.resetFields(); setModalVisible(true) }}>创建成员组</Button>
          </Space>
        </div>
        {loading ? <Spin dot style={{ display: 'block', margin: '20px auto' }} /> :
         groups.length === 0 ? <Empty description="暂无成员组" /> :
         <Table columns={columns} data={groups} rowKey="id" pagination={{ pageSize: 15 }} size="small" />
        }
      </Card>

      <Modal
        title={editId ? '编辑成员组' : '创建成员组'} visible={modalVisible}
        onCancel={() => { setModalVisible(false); setEditId(null) }} onOk={handleSubmit}
        okText="保存" cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Form.Item field="name" label="成员组名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="如：创作组" />
          </Form.Item>
          <Form.Item field="description" label="描述">
            <Input.TextArea placeholder="可选" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default TeamMemberGroupsPage
