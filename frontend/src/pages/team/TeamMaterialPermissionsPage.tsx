/**
 * TeamMaterialPermissionsPage - 企业素材库权限 (M2)
 *
 * 成员 × 权限矩阵(查看/上传/下载/编辑/删除/调用), 支持批量设置.
 * 级联规则提示: 授予高权限自动补 view; 授予 delete 自动补 edit+view; 取消 view 全部取消.
 */
import React, { useEffect, useState, useCallback } from 'react'
import {
  Card, Spin, Table, Typography, Button, Space, Alert, Switch, Message, Tag,
} from '@arco-design/web-react'
import { IconRefresh } from '@arco-design/web-react/icon'
import { teamService } from '@/api/services'
import { useTeamStore } from '@/stores'

const { Title, Text } = Typography

const PERMS = [
  { key: 'can_view', label: '查看' },
  { key: 'can_upload', label: '上传' },
  { key: 'can_download', label: '下载' },
  { key: 'can_edit', label: '编辑' },
  { key: 'can_delete', label: '删除' },
  { key: 'can_invoke', label: '调用' },
]

const TeamMaterialPermissionsPage: React.FC = () => {
  const { currentOrg } = useTeamStore()
  const orgId = currentOrg?.id
  const [members, setMembers] = useState<any[]>([])
  const [perms, setPerms] = useState<Record<string, any>>({}) // userId -> perm
  const [loading, setLoading] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])

  const load = useCallback(async () => {
    if (!orgId) return
    setLoading(true)
    try {
      const [memRes, permRes]: any = await Promise.all([
        teamService.members.list(orgId),
        teamService.materialPermissions(orgId).list(),
      ])
      const memList = Array.isArray(memRes) ? memRes : (memRes?.data ?? [])
      const permList = Array.isArray(permRes) ? permRes : (permRes?.data ?? [])
      setMembers(memList)
      // 构建 userId -> perm 映射; 默认 view=true 其余 false
      const map: Record<string, any> = {}
      memList.forEach((m: any) => {
        const p = permList.find((x: any) => x.user_id === m.user_id)
        map[m.user_id] = p || {
          can_view: true, can_upload: false, can_download: false,
          can_edit: false, can_delete: false, can_invoke: false,
        }
      })
      setPerms(map)
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [orgId])

  useEffect(() => { load() }, [load])

  const handleToggle = async (userId: string, permKey: string, val: boolean) => {
    // 乐观更新
    const prev = perms[userId]
    setPerms({ ...perms, [userId]: { ...prev, [permKey]: val } })
    try {
      const res: any = await teamService.materialPermissions(orgId).set(userId, { [permKey]: val })
      // 用服务端返回(含级联)覆盖
      const d = res?.data ?? res
      setPerms({ ...perms, [userId]: d })
    } catch {
      setPerms({ ...perms, [userId]: prev }) // 回滚
      Message.error('设置失败')
    }
  }

  const columns = [
    {
      title: '成员信息', dataIndex: 'nickname',
      render: (v: string, r: any) => (
        <div><Text bold>{v}</Text> <Tag>{r.role === 'owner' ? '创建者' : r.role === 'admin' ? '管理员' : '成员'}</Tag></div>
      ),
    },
    ...PERMS.map((p) => ({
      title: p.label, key: p.key, width: 80, align: 'center' as const,
      render: (_v: any, r: any) => (
        <Switch
          checked={!!perms[r.user_id]?.[p.key]}
          onChange={(v) => handleToggle(r.user_id, p.key, v)}
          disabled={loading}
        />
      ),
    })),
  ]

  return (
    <div>
      <Title heading={5} style={{ marginBottom: 20 }}>企业素材库权限</Title>

      <Alert
        type="info"
        style={{ marginBottom: 16 }}
        content={
          <div>
            <Text bold>企业素材库使用独立的六项权限</Text>
            <div style={{ marginTop: 4, fontSize: 13 }}>
              授予上传/下载/编辑/调用会自动授予查看；授予删除会自动授予编辑和查看；取消查看会取消其余全部权限。
            </div>
          </div>
        }
      />

      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <Text type="secondary">成员权限矩阵</Text>
          <Button icon={<IconRefresh />} onClick={load}>刷新</Button>
        </div>
        {loading ? <Spin dot style={{ display: 'block', margin: '20px auto' }} /> :
          <Table
            columns={columns} data={members} rowKey="user_id"
            pagination={false} size="small"
            rowSelection={{
              type: 'checkbox',
              selectedRowKeys: selectedKeys,
              onChange: (keys: any) => setSelectedKeys(keys as string[]),
            }}
            scroll={{ x: 700 }}
          />
        }
      </Card>
    </div>
  )
}

export default TeamMaterialPermissionsPage
