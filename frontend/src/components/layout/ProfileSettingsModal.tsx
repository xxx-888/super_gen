/**
 * ProfileSettingsModal - 个人设置弹窗（MainLayout 右上角头像下拉进入）
 *
 * 三块内容：
 * 1. 基本资料：昵称 / 头像 URL（邮箱、手机号只读展示）
 * 2. 账号安全：邮箱验证（验证后可找回密码/授权换绑手机）、手机号更换/解绑
 *    （旧号丢失走「邮箱授权换绑」死号复活通道）
 * 3. 修改密码：原密码 + 新密码 + 确认新密码
 * 保存资料成功后拉取 /auth/me 并 saveUser，顶栏昵称/头像即时刷新
 */
import React, { useEffect, useState } from 'react'
import { Modal, Form, Input, Button, Avatar, Message, Divider, Typography, Tag, Space } from '@arco-design/web-react'
import { apiClient } from '@/api/client'
import { authService, securityService } from '@/api/services'
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

  // ===== 邮箱验证 =====
  const [emailCode, setEmailCode] = useState('')
  const [sendingEmailCode, setSendingEmailCode] = useState(false)
  const [emailCd, setEmailCd] = useState(0)   // 发送冷却倒计时
  const [verifying, setVerifying] = useState(false)

  // ===== 手机号 =====
  const [phoneMode, setPhoneMode] = useState<'none' | 'rebind' | 'rebindByEmail' | 'unbind'>('none')
  const [oldCode, setOldCode] = useState('')
  const [newPhone, setNewPhone] = useState('')
  const [newCode, setNewCode] = useState('')
  const [unbindingEmailCode, setUnbindingEmailCode] = useState('')
  const [phoneBusy, setPhoneBusy] = useState(false)

  // 打开时加载当前用户信息回填
  useEffect(() => {
    if (!visible) return
    apiClient.get('/auth/me').then((u: any) => {
      setUser(u)
      profileForm.setFieldsValue({ nickname: u.nickname, avatar_url: u.avatar_url || '' })
    }).catch(() => { /* 拦截器已提示 */ })
    pwdForm.resetFields()
  }, [visible, profileForm, pwdForm])

  // 邮箱验证码 60s 冷却倒计时
  useEffect(() => {
    if (emailCd <= 0) return
    const t = setTimeout(() => setEmailCd((s) => s - 1), 1000)
    return () => clearTimeout(t)
  }, [emailCd])

  const refreshMe = async () => {
    const me: any = await apiClient.get('/auth/me')
    saveUser(me)
    setUser(me)
  }

  const handleSaveProfile = async () => {
    const v = profileForm.getFieldsValue()
    setSavingProfile(true)
    try {
      await authService.updateProfile({ nickname: v.nickname, avatar_url: v.avatar_url })
      await refreshMe()
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

  // ===== 邮箱验证 =====
  const handleSendEmailCode = async (purpose: 'bind_email' | 'rebind_authorize') => {
    setSendingEmailCode(true)
    try {
      await securityService.sendEmailCode(purpose)
      Message.success('验证码已发送至你的邮箱')
      setEmailCd(60)
    } catch { /* 拦截器已提示 */ } finally { setSendingEmailCode(false) }
  }

  const handleVerifyEmail = async () => {
    if (!emailCode.trim()) { Message.warning('请输入邮箱验证码'); return }
    setVerifying(true)
    try {
      await securityService.verifyEmail(emailCode.trim())
      Message.success('邮箱验证成功！现在可以用邮箱找回密码了')
      setEmailCode('')
      await refreshMe()
    } catch { /* 拦截器已提示 */ } finally { setVerifying(false) }
  }

  // ===== 手机号 =====
  const sendOldCode = async () => {
    setSendingEmailCode(true)
    try {
      await securityService.sendPhoneCode('old')
      Message.success('验证码已发送至当前绑定手机号')
    } catch { /* 拦截器已提示 */ } finally { setSendingEmailCode(false) }
  }
  const sendNewCode = async () => {
    if (!newPhone.trim()) { Message.warning('请填写新手机号'); return }
    setSendingEmailCode(true)
    try {
      await securityService.sendPhoneCode('new', newPhone.trim())
      Message.success('验证码已发送至新手机号')
    } catch { /* 拦截器已提示 */ } finally { setSendingEmailCode(false) }
  }

  const handleRebind = async () => {
    setPhoneBusy(true)
    try {
      await securityService.rebindPhone(oldCode.trim(), newPhone.trim(), newCode.trim())
      Message.success('手机号已更换')
      setPhoneMode('none'); setOldCode(''); setNewPhone(''); setNewCode('')
      await refreshMe()
    } catch { /* 拦截器已提示 */ } finally { setPhoneBusy(false) }
  }

  const handleRebindByEmail = async () => {
    setPhoneBusy(true)
    try {
      await securityService.rebindPhoneByEmail(emailCode.trim(), newPhone.trim(), newCode.trim())
      Message.success('手机号已更换（邮箱授权通道）')
      setPhoneMode('none'); setEmailCode(''); setNewPhone(''); setNewCode('')
      await refreshMe()
    } catch { /* 拦截器已提示 */ } finally { setPhoneBusy(false) }
  }

  const handleUnbind = async () => {
    setPhoneBusy(true)
    try {
      await securityService.unbindPhone(unbindingEmailCode.trim())
      Message.success('手机号已解绑')
      setPhoneMode('none'); setUnbindingEmailCode('')
      await refreshMe()
    } catch { /* 拦截器已提示 */ } finally { setPhoneBusy(false) }
  }

  const avatarSrc = profileForm.getFieldValue('avatar_url') || user?.avatar_url
  const emailVerified = !!user?.email_verified

  return (
    <Modal
      title="个人设置"
      visible={visible}
      onCancel={onCancel}
      footer={null}
      style={{ width: 500, maxWidth: '94vw' }}
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
            <Text type="secondary" style={{ fontSize: 12 }}>
              {user?.email}
              {emailVerified && <Tag size="small" color="green" style={{ marginLeft: 6 }}>已验证</Tag>}
            </Text>
            {user?.phone && <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>📱 {user.phone}</Text>}
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

      {/* ---- 账号安全 ---- */}
      <Text type="secondary" style={{ fontSize: 13 }}>账号安全</Text>

      {/* 邮箱验证 */}
      <div style={{ marginTop: 10, padding: 10, background: 'var(--color-fill-2)', borderRadius: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ fontSize: 13 }}>
            邮箱验证
            <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
              {emailVerified ? '已验证，可用于找回密码' : '验证后可解锁邮箱找回密码、授权换绑手机'}
            </Text>
          </Text>
          {!emailVerified && (
            <Button size="mini" type="outline" loading={sendingEmailCode} disabled={emailCd > 0}
              onClick={() => handleSendEmailCode('bind_email')}>
              {emailCd > 0 ? `${emailCd}s 后重发` : '发送验证码'}
            </Button>
          )}
        </div>
        {!emailVerified && (
          <Space style={{ marginTop: 8 }} size={8}>
            <Input size="small" placeholder="邮箱验证码" style={{ width: 130 }} maxLength={8}
              value={emailCode} onChange={setEmailCode} />
            <Button size="small" type="primary" loading={verifying} onClick={handleVerifyEmail}>验证</Button>
          </Space>
        )}
      </div>

      {/* 手机号管理 */}
      <div style={{ marginTop: 10, padding: 10, background: 'var(--color-fill-2)', borderRadius: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ fontSize: 13 }}>
            手机号
            <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
              {user?.phone ? `当前绑定 ${user.phone}` : '未绑定（验证邮箱后可绑定，作为找回通道）'}
            </Text>
          </Text>
          {user?.phone ? (
            <Space size={4}>
              <Button size="mini" type="outline" onClick={() => {
                setPhoneMode(phoneMode === 'rebind' ? 'none' : 'rebind'); setOldCode(''); setNewPhone(''); setNewCode('')
              }}>更换</Button>
              <Button size="mini" status="danger" onClick={() => {
                setPhoneMode(phoneMode === 'unbind' ? 'none' : 'unbind'); setUnbindingEmailCode('')
              }}>解绑</Button>
            </Space>
          ) : (
            <Button size="mini" type="outline" onClick={() => {
              setPhoneMode(phoneMode === 'rebindByEmail' ? 'none' : 'rebindByEmail'); setNewPhone(''); setNewCode(''); setEmailCode('')
            }}>绑定手机号</Button>
          )}
        </div>

        {/* 常规换绑: 旧号验证码 + 新号验证码 */}
        {phoneMode === 'rebind' && user?.phone && (
          <div style={{ marginTop: 8 }}>
            <Space size={8} style={{ marginBottom: 8 }} wrap>
              <Input size="small" placeholder="旧手机验证码" style={{ width: 130 }} maxLength={8} value={oldCode} onChange={setOldCode} />
              <Button size="small" loading={sendingEmailCode} onClick={sendOldCode}>发送旧号验证码</Button>
            </Space>
            <Space size={8} wrap>
              <Input size="small" placeholder="新手机号" style={{ width: 130 }} maxLength={11} value={newPhone} onChange={setNewPhone} />
              <Input size="small" placeholder="新手机验证码" style={{ width: 130 }} maxLength={8} value={newCode} onChange={setNewCode} />
              <Button size="small" type="primary" loading={phoneBusy} onClick={sendNewCode}>发送新号验证码</Button>
              <Button size="small" type="primary" status="success" loading={phoneBusy} onClick={handleRebind}>确认更换</Button>
            </Space>
            <div style={{ marginTop: 6 }}>
              <Button size="mini" type="text" onClick={() => { setPhoneMode('rebindByEmail'); setOldCode(''); setNewCode('') }}>
                旧手机号收不到短信？走邮箱授权通道 →
              </Button>
            </div>
          </div>
        )}

        {/* 死号复活: 邮箱授权换绑 */}
        {phoneMode === 'rebindByEmail' && (
          <div style={{ marginTop: 8 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              需要邮箱已验证 + 邮箱验证码（「验证邮箱」按钮发送，purpose=授权换绑）
            </Text>
            <Space size={8} style={{ marginTop: 8 }} wrap>
              <Input size="small" placeholder="邮箱验证码" style={{ width: 130 }} maxLength={8} value={emailCode} onChange={setEmailCode} />
              {emailVerified && (
                <Button size="small" loading={sendingEmailCode} disabled={emailCd > 0}
                  onClick={() => handleSendEmailCode('rebind_authorize')}>
                  {emailCd > 0 ? `${emailCd}s` : '发邮箱验证码'}
                </Button>
              )}
            </Space>
            <Space size={8} style={{ marginTop: 8 }} wrap>
              <Input size="small" placeholder="新手机号" style={{ width: 130 }} maxLength={11} value={newPhone} onChange={setNewPhone} />
              <Input size="small" placeholder="新手机验证码" style={{ width: 130 }} maxLength={8} value={newCode} onChange={setNewCode} />
              <Button size="small" type="primary" loading={phoneBusy} onClick={sendNewCode}>发送新号验证码</Button>
              <Button size="small" type="primary" status="success" loading={phoneBusy} onClick={handleRebindByEmail}>确认更换</Button>
            </Space>
          </div>
        )}

        {/* 解绑: 需邮箱授权 */}
        {phoneMode === 'unbind' && (
          <div style={{ marginTop: 8 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              解绑后手机号不可用于登录找回，需邮箱已验证作为替代找回通道
            </Text>
            <Space size={8} style={{ marginTop: 8 }} wrap>
              <Input size="small" placeholder="邮箱验证码" style={{ width: 130 }} maxLength={8} value={unbindingEmailCode} onChange={setUnbindingEmailCode} />
              {emailVerified && (
                <Button size="small" loading={sendingEmailCode} disabled={emailCd > 0}
                  onClick={() => handleSendEmailCode('rebind_authorize')}>
                  {emailCd > 0 ? `${emailCd}s` : '发邮箱验证码'}
                </Button>
              )}
              <Button size="small" status="danger" loading={phoneBusy} onClick={handleUnbind} disabled={!emailVerified}>
                确认解绑
              </Button>
            </Space>
          </div>
        )}
      </div>

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
