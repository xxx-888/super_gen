/**
 * TeamMaterialPermissionsPage - 企业素材库权限 (M2)
 *
 * 成员 × 六项权限矩阵（查看/上传/下载/编辑/删除/引用）——这是素材库的唯一执行权限：
 * 素材库接口按此矩阵实时拦截。支持按成员组批量选择 + 对所选成员批量设置。
 * 级联规则: 授予高权限自动补 view; 授予 delete 自动补 edit+view; 取消 view 全部取消。
 * 未配置过的成员走默认宽松策略（可查看/上传/下载/引用，不可编辑/删除）。
 */
import React, { useEffect, useState, useCallback } from 'react'
import {
  Card, Spin, Table, Typography, Button, Space, Alert, Switch, Message, Tag, Select, Modal, Form,
} from '@arco-design/web-react'
import { IconRefresh, IconSettings } from '@arco-design/web-react/icon'
import { teamService } from '@/api/services'
import { useTeamStore } from '@/stores'

const { Title, Text } = Typography

const PERMS = [
  { key: 'can_view', label: '查看' },
  { key: 'can_upload', label: '上传' },
  { key: 'can_download', label: '下载' },
  { key: 'can_edit', label: '编辑' },
  { key: 'can_delete', label: '删除' },
  { key: 'can_invoke', label: '引用' },
]

// 与后端 DEFAULT_MEMBER_PERMS 一致（未配置成员的默认策略）
const DEFAULT_PERMS = {
  can_view: true, can_upload: true, can_download: true,
  can_edit: false, can_delete: false, can_invoke: true,
}

const TeamMaterialPermissionsPage: React.FC = () => {
  const { currentOrg } = useTeamStore()
  const orgId = currentOrg?.id
  const [members, setMembers] = useState<any[]>([])
  const [perms, setPerms] = useState<Record<string, any>>({}) // userId -> perm（含 _isDefault 标记）
  const [configured, setConfigured] = useState<Set<string>>(new Set()) // 已显式配置的成员
  const [memberGroups, setMemberGroups] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])

  // 批量设置弹窗
  const [batchVisible, setBatchVisible] = useState(false)
  const [batchForm] = Form.useForm()
  const [batchSaving, setBatchSaving] = useState(false)

  const load = useCallback(async () => {
    if (!orgId) return
    setLoading(true)
    try {
      const [memRes, permRes, mgRes]: any = await Promise.all([
        teamService.members.list(orgId),
        teamService.materialPermissions(orgId).list(),
        teamService.memberGroups(orgId).list().catch(() => []),
      ])
      const memList = Array.isArray(memRes) ? memRes : (memRes?.data ?? [])
      const permList = Array.isArray(permRes) ? permRes : (permRes?.data ?? [])
      setMembers(memList)
      setMemberGroups(Array.isArray(mgRes) ? mgRes : (mgRes?.data ?? []))
      const conf = new Set<string>(permList.map((x: any) => x.user_id))
      setConfigured(conf)
      const map: Record<string, any> = {}
      memList.forEach((m: any) => {
        const p = permList.find((x: any) => x.user_id === m.user_id)
        map[m.user_id] = p || { ...DEFAULT_PERMS, _isDefault: true }
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
      setConfigured((s) => new Set(s).add(userId))
    } catch {
      setPerms({ ...perms, [userId]: prev }) // 回滚
      Message.error('设置失败')
    }
  }

  const selectMemberGroup = (gid: string) => {
    const g: any = memberGroups.find((x: any) => x.id === gid)
    if (!g) return
    setSelectedKeys((g.member_ids || []).filter((uid: string) => members.some((m: any) => m.user_id === uid)))
    Message.info(`已选中「${g.name}」的 ${(g.member_ids || []).length} 位成员，可批量设置`)
  }

  const handleBatchSave = async () => {
    if (!selectedKeys.length) { Message.warning('请先勾选成员'); return }
    try {
      const v = await batchForm.validate()
      const permissions: Record<string, boolean> = {}
      PERMS.forEach((p) => { permissions[p.key] = v[p.key] !== false ? true : false })
      // 只有显式开/关的算设置——表单默认三态简化为全量提交（模板快照语义）
      setBatchSaving(true)
      const res: any = await teamService.materialPermissions(orgId).batch({
        user_ids: selectedKeys, permissions,
      })
      const n = res?.data?.updated ?? res?.updated
      Message.success(`已批量设置 ${n ?? selectedKeys.length} 位成员`)
      setBatchVisible(false); batchForm.resetFields(); load()
    } catch (e: any) {
      if (e?.errorFields) return
      Message.error('批量设置失败')
    } finally { setBatchSaving(false) }
  }

  const columns = [
    {
      title: '成员信息', dataIndex: 'nickname',
      render: (v: string, r: any) => (
        <div>
          <Space size={6}>
            <Text bold>{v}</Text>
            <Tag>{r.role === 'owner' ? '创建者' : r.role === 'admin' ? '管理员' : '成员'}</Tag>
            {perms[r.user_id]?._isDefault && <Tag color="gray" style={{ fontSize: 11 }}>默认策略</Tag>}
          </Space>
        </div>
      ),
    },
    ...PERMS.map((p) => ({
      title: p.label, key: p.key, width: 80, align: 'center' as const,
      render: (_v: any, r: any) => (
        <Switch
          checked={!!perms[r.user_id]?.[p.key]}
          onChange={(v) => handleToggle(r.user_id, p.key, v)}
          disabled={loading || r.role === 'owner' || r.role === 'admin'}
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
            <Text bold>此矩阵是素材库的执行权限，实时生效</Text>
            <div style={{ marginTop: 4, fontSize: 13, lineHeight: 1.7 }}>
              创建者/管理员默认拥有全部权限；普通成员未配置时走默认策略（可查看/上传/下载/引用，不可编辑/删除），
              一旦配置即按配置生效。被关闭「查看」的成员将无法访问素材库列表与文件。<br />
              级联：授予上传/下载/编辑/引用自动补查看；授予删除自动补编辑和查看；取消查看会取消其余全部。
            </div>
          </div>
        }
      />

      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
          <Space wrap>
            <Text type="secondary">成员权限矩阵（已选 {selectedKeys.length} 人）</Text>
            {memberGroups.length > 0 && (
              <Select
                style={{ width: 200 }} placeholder="按成员组勾选…" allowClear
                onChange={(v) => v && selectMemberGroup(v)}
                options={memberGroups.map((g: any) => ({
                  label: `${g.name}（${g.member_count ?? (g.member_ids || []).length} 人）`,
                  value: g.id,
                }))}
              />
            )}
            <Button size="small" icon={<IconSettings />} disabled={!selectedKeys.length} onClick={() => setBatchVisible(true)}>
              批量设置所选成员
            </Button>
          </Space>
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
              checkboxProps: (r: any) => ({ disabled: r.role === 'owner' || r.role === 'admin' }),
            }}
            scroll={{ x: 700 }}
          />
        }
      </Card>

      {/* 批量设置 */}
      <Modal
        title={`批量设置 ${selectedKeys.length} 位成员的素材库权限`}
        visible={batchVisible}
        onCancel={() => setBatchVisible(false)}
        onOk={handleBatchSave}
        confirmLoading={batchSaving}
        okText="应用到所选成员" cancelText="取消"
        style={{ width: 440 }}
      >
        <Alert
          type="warning" style={{ marginBottom: 12 }}
          content="将整体覆盖所选成员的六项权限（模板快照），未打开的项会被关闭。"
        />
        <Form form={batchForm} layout="vertical">
          {PERMS.map((p) => (
            <Form.Item key={p.key} field={p.key} label={p.label} triggerPropName="checked" style={{ marginBottom: 6 }} initialValue={DEFAULT_PERMS[p.key as keyof typeof DEFAULT_PERMS]}>
              <Switch />
            </Form.Item>
          ))}
        </Form>
      </Modal>
    </div>
  )
}

export default TeamMaterialPermissionsPage
