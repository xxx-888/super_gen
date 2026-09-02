/**
 * LegalDocPage - 法律文档通用渲染组件（用户服务协议 / 隐私政策共用）
 *
 * 独立公开页面（无需登录），顶部品牌栏 + 返回上一页，正文分节排版；
 * 末尾「联系我们」卡片动态取系统设置配置的联系方式
 */
import React from 'react'
import { Button, Typography } from '@arco-design/web-react'
import { IconLeft, IconEmail, IconPhone, IconUser } from '@arco-design/web-react/icon'
import { useNavigate } from 'react-router-dom'
import { useSiteConfig } from '@/hooks/useSiteConfig'

const { Title, Text, Paragraph } = Typography

export type LegalSection = {
  heading: string
  paragraphs: string[]
}

export type LegalContact = {
  email?: string
  qq?: string
  phone?: string
}

type Props = {
  docTitle: string
  updated: string
  intro: string
  sections: LegalSection[]
}

const LegalDocPage: React.FC<Props> = ({ docTitle, updated, intro, sections }) => {
  const siteConfig = useSiteConfig()
  const navigate = useNavigate()
  const contact: LegalContact = {
    email: (siteConfig.contact_email || '').trim() || undefined,
    qq: (siteConfig.contact_qq || '').trim() || undefined,
    phone: (siteConfig.contact_phone || '').trim() || undefined,
  }

  // 文档多以 target=_blank 新标签打开（无历史可退），此时回登录页兜底
  const handleBack = () => {
    if (window.history.length > 1) window.history.back()
    else navigate('/login', { replace: true })
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
          <Text type="secondary" style={{ fontSize: 13 }}>{docTitle}</Text>
        </div>
        <Button size="small" icon={<IconLeft />} onClick={handleBack}>
          返回
        </Button>
      </header>

      {/* 正文 */}
      <main style={{ maxWidth: 860, margin: '0 auto', padding: '40px 24px 80px' }}>
        <div style={{
          background: 'var(--color-bg-2)', borderRadius: 8,
          padding: '36px 44px', boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
        }}>
          <Title heading={3} style={{ marginTop: 0, marginBottom: 8 }}>{docTitle}</Title>
          <Text type="secondary" style={{ fontSize: 13 }}>更新/生效日期：{updated}</Text>

          <Paragraph style={{ color: 'var(--color-text-2)', lineHeight: 1.9, marginTop: 16 }}>{intro}</Paragraph>

          {sections.map((s, i) => (
            <section key={i} style={{ marginTop: 28 }}>
              <Title heading={5} style={{ marginBottom: 10 }}>{`${i + 1}. ${s.heading}`}</Title>
              {s.paragraphs.map((p, j) => (
                <Paragraph key={j} style={{ color: 'var(--color-text-2)', lineHeight: 1.9, marginBottom: 10, fontSize: 14 }}>
                  {p}
                </Paragraph>
              ))}
            </section>
          ))}

          {/* 联系我们（后台系统设置动态配置） */}
          <section style={{
            marginTop: 36, padding: '18px 20px', borderRadius: 8,
            background: 'var(--color-fill-1)', border: '1px solid var(--color-border-2)',
          }}>
            <Title heading={5} style={{ marginBottom: 12 }}>联系我们</Title>
            {contact.email || contact.qq || contact.phone ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {contact.email && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14 }}>
                    <IconEmail style={{ color: 'rgb(var(--primary-6))' }} />
                    <span style={{ color: 'var(--color-text-3)', width: 64 }}>邮箱</span>
                    <a href={`mailto:${contact.email}`} style={{ color: 'rgb(var(--primary-6))' }}>{contact.email}</a>
                    <Text copyable={{ text: contact.email }} style={{ fontSize: 12 }} />
                  </div>
                )}
                {contact.qq && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14 }}>
                    <IconUser style={{ color: 'rgb(var(--primary-6))' }} />
                    <span style={{ color: 'var(--color-text-3)', width: 64 }}>QQ</span>
                    <Text copyable={{ text: contact.qq }}>{contact.qq}</Text>
                  </div>
                )}
                {contact.phone && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14 }}>
                    <IconPhone style={{ color: 'rgb(var(--primary-6))' }} />
                    <span style={{ color: 'var(--color-text-3)', width: 64 }}>电话</span>
                    <a href={`tel:${contact.phone}`} style={{ color: 'rgb(var(--primary-6))' }}>{contact.phone}</a>
                    <Text copyable={{ text: contact.phone }} style={{ fontSize: 12 }} />
                  </div>
                )}
              </div>
            ) : (
              <Paragraph style={{ color: 'var(--color-text-2)', lineHeight: 1.9, marginBottom: 0, fontSize: 14 }}>
                如需与我们取得联系，可通过平台内公示的其他渠道反馈，我们会尽快回复。
              </Paragraph>
            )}
          </section>

          <div style={{ marginTop: 40, paddingTop: 20, borderTop: '1px solid var(--color-border-2)', textAlign: 'center' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              — {siteConfig.site_name} · {docTitle} · 完 —
            </Text>
          </div>
        </div>
      </main>
    </div>
  )
}

export default LegalDocPage
