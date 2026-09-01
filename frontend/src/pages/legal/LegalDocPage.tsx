/**
 * LegalDocPage - 法律文档通用渲染组件（用户服务协议 / 隐私政策共用）
 *
 * 独立公开页面（无需登录），顶部品牌栏 + 返回上一页，正文分节排版
 */
import React from 'react'
import { Button, Typography } from '@arco-design/web-react'
import { IconLeft } from '@arco-design/web-react/icon'
import { useSiteConfig } from '@/hooks/useSiteConfig'

const { Title, Text, Paragraph } = Typography

export type LegalSection = {
  heading: string
  paragraphs: string[]
}

type Props = {
  docTitle: string
  updated: string
  intro: string
  sections: LegalSection[]
}

const LegalDocPage: React.FC<Props> = ({ docTitle, updated, intro, sections }) => {
  const siteConfig = useSiteConfig()

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
        <Button size="small" icon={<IconLeft />} onClick={() => window.history.back()}>
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
