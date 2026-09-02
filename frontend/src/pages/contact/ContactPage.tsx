/**
 * ContactPage - 联系我们（公开页面，无需登录）
 *
 * 左侧：联系方式（后台系统设置动态配置：邮箱/QQ/电话）
 * 右侧：在线留言表单（类型/称呼/联系方式/内容），提交至 POST /contact
 */
import React, { useState } from 'react'
import {
  Button, Typography, Message, Form, Input, Radio, Card,
} from '@arco-design/web-react'
import { IconEmail, IconPhone, IconUser, IconLeft } from '@arco-design/web-react/icon'
import { Link } from 'react-router-dom'
import { contactService } from '@/api/services'
import { useSiteConfig } from '@/hooks/useSiteConfig'

const { Title, Text } = Typography

const MSG_TYPES = [
  { value: 'suggestion', label: '功能建议' },
  { value: 'bug', label: '问题反馈' },
  { value: 'cooperation', label: '商务合作' },
  { value: 'other', label: '其他' },
]

const ContactPage: React.FC = () => {
  const siteConfig = useSiteConfig()
  const [form] = Form.useForm()
  const [submitting, setSubmitting] = useState(false)

  const contact = {
    email: (siteConfig.contact_email || '').trim(),
    qq: (siteConfig.contact_qq || '').trim(),
    phone: (siteConfig.contact_phone || '').trim(),
  }

  const handleSubmit = async (values: Record<string, any>) => {
    const v = values || form.getFieldsValue()
    if (!v?.content || v.content.trim().length < 5) {
      Message.error('留言内容至少 5 个字符')
      return
    }
    setSubmitting(true)
    try {
      await contactService.submit({
        name: (v.name || '').trim(),
        contact: (v.contact || '').trim(),
        msg_type: v.msg_type || 'suggestion',
        content: v.content.trim(),
      })
      Message.success('提交成功，感谢你的反馈！我们会尽快处理')
      form.resetFields()
    } catch (e: any) {
      const detail = e?.response?.data?.detail
      Message.error(typeof detail === 'string' && detail ? detail : '提交失败，请稍后重试')
      console.error('Contact submit failed:', e)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--color-fill-1)' }}>
      {/* 顶部栏 */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 10,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 32px', background: 'var(--color-bg-2)',
        borderBottom: '1px solid var(--color-border-2)',
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span style={{ fontSize: 17, fontWeight: 700 }}>{siteConfig.site_name}</span>
          <Text type="secondary" style={{ fontSize: 13 }}>联系我们</Text>
        </div>
        <Link to="/login" style={{ color: 'rgb(var(--primary-6))', fontSize: 13, textDecoration: 'none' }}>
          <IconLeft style={{ marginRight: 4, verticalAlign: -2 }} />返回
        </Link>
      </header>

      <main style={{ maxWidth: 960, margin: '0 auto', padding: '40px 24px 80px' }}>
        <div style={{ marginBottom: 24 }}>
          <Title heading={3} style={{ marginTop: 0, marginBottom: 8 }}>联系我们</Title>
          <Text type="secondary">意见建议、问题反馈或商务合作，欢迎随时留言，我们会尽快回复</Text>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 20 }}>
          {/* 联系方式 */}
          <Card title="联系方式" style={{ height: 'fit-content' }}>
            {(contact.email || contact.qq || contact.phone) ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '8px 0' }}>
                {contact.email && (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <IconEmail style={{ color: 'rgb(var(--primary-6))' }} />
                      <Text type="secondary" style={{ fontSize: 13 }}>邮箱</Text>
                    </div>
                    <a href={`mailto:${contact.email}`} style={{ color: 'rgb(var(--primary-6))', fontSize: 14, marginLeft: 22 }}>{contact.email}</a>
                  </div>
                )}
                {contact.qq && (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <IconUser style={{ color: 'rgb(var(--primary-6))' }} />
                      <Text type="secondary" style={{ fontSize: 13 }}>QQ</Text>
                    </div>
                    <Text copyable={{ text: contact.qq }} style={{ fontSize: 14, marginLeft: 22 }}>{contact.qq}</Text>
                  </div>
                )}
                {contact.phone && (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <IconPhone style={{ color: 'rgb(var(--primary-6))' }} />
                      <Text type="secondary" style={{ fontSize: 13 }}>电话</Text>
                    </div>
                    <a href={`tel:${contact.phone}`} style={{ color: 'rgb(var(--primary-6))', fontSize: 14, marginLeft: 22 }}>{contact.phone}</a>
                  </div>
                )}
              </div>
            ) : (
              <Text type="secondary" style={{ lineHeight: 1.9 }}>
                联系方式正在完善中，你可以直接通过右侧表单留言，我们会尽快处理。
              </Text>
            )}
            <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--color-border-2)' }}>
              <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.8 }}>
                留言提交后可在 1-3 个工作日内得到处理；紧急问题建议优先通过电话联系。
              </Text>
            </div>
          </Card>

          {/* 在线留言 */}
          <Card title="在线留言">
            <Form form={form} layout="vertical" onSubmit={handleSubmit} requiredSymbol={false}>
              <Form.Item field="msg_type" label="留言类型" initialValue="suggestion">
                <Radio.Group type="button" size="small">
                  {MSG_TYPES.map(t => <Radio key={t.value} value={t.value}>{t.label}</Radio>)}
                </Radio.Group>
              </Form.Item>
              <Form.Item field="name" label="怎么称呼你（可选）">
                <Input placeholder="如：张先生" maxLength={100} allowClear />
              </Form.Item>
              <Form.Item field="contact" label="联系方式（可选，方便我们回复你）">
                <Input placeholder="邮箱 / 手机号 / QQ" maxLength={255} allowClear />
              </Form.Item>
              <Form.Item
                field="content"
                label="留言内容"
                rules={[
                  { required: true, message: '请输入留言内容' },
                  { minLength: 5, message: '留言内容至少 5 个字符' },
                ]}
              >
                <Input.TextArea
                  placeholder="请描述你的建议或遇到的问题（5-2000 字）"
                  maxLength={2000}
                  showWordLimit
                  autoSize={{ minRows: 5, maxRows: 10 }}
                />
              </Form.Item>
              <Button type="primary" htmlType="submit" long loading={submitting} size="large">
                提交留言
              </Button>
            </Form>
          </Card>
        </div>
      </main>
    </div>
  )
}

export default ContactPage
