/**
 * ProfileSettingsModal - 个人设置弹窗（MainLayout 右上角头像下拉进入）
 *
 * 两块内容：
 * 1. 基本资料：昵称 / 头像 URL（邮箱、手机号只读展示）
 * 2. 修改密码：原密码 + 新密码 + 确认新密码
 * 保存资料成功后拉取 /auth/me 并 saveUser，顶栏昵称/头像即时刷新
 */
import React, { useEffect, useState } from 'react'
import { Modal, Form, Input, Button, Avatar, Message, Divider, Typography } from '@arco-design/web-react'
import { apiClient } from '@/api/client'
import { authService } from '@/api/services'
import { saveUser } from '@/utils/auth'

const { Text } = Typography

type Props = {
  visible: boolean
  onCancel: () => void
}

const ProfileSettingsModal: React.FC<Props> = ({ visible, onCancel }) => {
  const [profileForm] = Form.useForm()
  const [pwdForm] = Form.useForm()
  const [savingProfile, setSavingProfile] = useState(false)
  const [savingPwd, setSavingPwd] = useState(false)
  const [user, setUser] = useState<any>(null)

  // 打开时加载当前用户信息回填
  useEffect(() => {
    if (!visible) return
    apiClient.get('/auth/me').then((u: any) => {
      setUser(u)
      profileForm.setFieldsValue({ nickname: u.nickname, avatar_url: u.avatar_url || '' })
    }).catch(() => { /* 拦截器已提示 */ })
    pwdForm.resetFields()
  }, [visible, profileForm, pwdForm])

  const handleSaveProfile = async () => {
    const v = profileForm.getFieldsValue()
    setSavingProfile(true)
    try {
      await authService.updateProfile({ nickname: v.nickname, avatar_url: v.avatar_url })
      // 拉最新信息刷新全局（顶栏昵称/头像即时生效）
      const me: any = await apiClient.get('/auth/me')
      saveUser(me)
      setUser(me)
      Message.success('资料已保存')
    } catch (e: any) {
      const detail = e?.response?.data?.detail
      Message.error(typeof detail === 'string' && detail ? detail : '保存失败，请稍后重试')
    } finally {
      setSavingProfile(false)
    }
  }

  const handleChangePassword = async (values: Record<string, any>) => {
    const v = values || pwdForm.getFieldsValue()
    if (!v?.old_password || !v?.new_password) {
      Message.error('请填写原密码与新密码')
      return
    }
    if (v.confirm_password !== v.new_password) {
      Message.error('两次输入的新密码不一致')
      return
    }
    setSavingPwd(true)
    try {
      await authService.changePassword({ old_password: v.old_password, new_password: v.new_password })
      Message.success('密码修改成功，下次登录请使用新密码')
      pwdForm.resetFields()
    } catch (e: any) {
      const detail = e?.response?.data?.detail
      Message.error(typeof detail === 'string' && detail ? detail : '修改失败，请稍后重试')
    } finally {
      setSavingPwd(false)
    }
  }

  const avatarSrc = profileForm.getFieldValue('avatar_url') || user?.avatar_url

  return (
    <Modal
      title="个人设置"
      visible={visible}
      onCancel={onCancel}
      footer={null}
      style={{ width: 460 }}
      unmountOnExit
    >
      {/* ---- 基本资料 ---- */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <Avatar size={44} style={{ background: 'rgb(var(--primary-6))', flexShrink: 0 }}>
          {avatarSrc
            ? <img src={avatarSrc} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
            : (user?.nickname || user?.email || 'U').slice(0, 1).toUpperCase()}
        </Avatar>
        <div>
          <Text style={{ fontWeight: 600 }}>{user?.nickname || '未设置昵称'}</Text>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>{user?.email}</Text>
            {user?.phone && <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>{user.phone}</Text>}
          </div>
        </div>
      </div>

      <Form form={profileForm} layout="vertical" size="small">
        <Form.Item field="nickname" label="昵称" rules={[{ required: true, message: '请输入昵称' }]}>
          <Input placeholder="昵称" maxLength={100} allowClear />
        </Form.Item>
        <Form.Item field="avatar_url" label="头像 URL">
          <Input placeholder="https://…/avatar.png（留空使用默认头像）" maxLength={2048} allowClear />
        </Form.Item>
        <Button type="primary" size="small" loading={savingProfile} onClick={handleSaveProfile}>
          保存资料
        </Button>
      </Form>

      <Divider style={{ margin: '20px 0 16px' }} />

      {/* ---- 修改密码 ---- */}
      <Text type="secondary" style={{ fontSize: 13 }}>修改登录密码</Text>
      <Form form={pwdForm} layout="vertical" size="small" onSubmit={handleChangePassword} style={{ marginTop: 8 }}>
        <Form.Item field="old_password" label="原密码" rules={[{ required: true, message: '请输入原密码' }]}>
          <Input.Password placeholder="当前使用的密码" />
        </Form.Item>
        <Form.Item field="new_password" label="新密码" rules={[{ required: true, message: '请输入新密码' }, { minLength: 8, message: '密码至少8个字符' }]}>
          <Input.Password placeholder="至少8个字符" />
        </Form.Item>
        <Form.Item
          field="confirm_password"
          label="确认新密码"
          dependencies={['new_password']}
          rules={[
            { required: true, message: '请再次输入新密码' },
            {
              validator: (value: any, callback: any) => {
                const pwd = pwdForm.getFieldValue('new_password')
                if (value && pwd && value !== pwd) callback('两次输入的密码不一致')
                else callback()
              },
            },
          ]}
        >
          <Input.Password placeholder="再次输入新密码" />
        </Form.Item>
        <Button htmlType="submit" size="small" loading={savingPwd}>修改密码</Button>
      </Form>
    </Modal>
  )
}

export default ProfileSettingsModal
