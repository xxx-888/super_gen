/**
 * NodeRefUpload - 节点内嵌"本节点参考素材"上传位
 *
 * 上传图片/视频后直接存到节点 data（不注册为项目资源），
 * 节点运行时优先用连线上游输入，其次用这里的上传值。
 * 点击已上传的素材可放大预览（图片大图 / 视频播放）。
 * 与 NodeUploadButton（注册为项目资源供 @引用）互补。
 */
import React, { useState } from 'react'
import { Upload, Button, Modal, Message } from '@arco-design/web-react'
import { IconUpload, IconDelete } from '@arco-design/web-react/icon'
import { uploadService } from '@/api/services'

interface NodeRefUploadProps {
  accept: 'image/*' | 'video/*'
  /** 已上传的素材 URL（节点 data 字段） */
  value?: string
  /** 上传/清除回调（undefined = 清除） */
  onChange: (url: string | undefined) => void
  label: string
}

export const NodeRefUpload: React.FC<NodeRefUploadProps> = ({ accept, value, onChange, label }) => {
  const isVideo = accept === 'video/*'
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)

  const handleUpload = async (file: File) => {
    try {
      const res: any = isVideo ? await uploadService.video(file) : await uploadService.image(file)
      const url = res?.url || res?.data?.url
      if (!url) throw new Error('上传返回缺少 url')
      onChange(url)
    } catch { /* 拦截器提示 */ }
  }

  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--color-text-3)', marginBottom: 2 }}>{label}</div>
      {value ? (
        <div style={{ position: 'relative', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--color-border)' }}>
          <div style={{ cursor: 'zoom-in' }} title="点击预览" onClick={() => setPreviewSrc(value)}>
            {isVideo ? (
              <video src={value} muted preload="metadata"
                style={{ width: '100%', height: 64, objectFit: 'cover', background: '#000', display: 'block' }} />
            ) : (
              <img src={value} alt="参考图"
                style={{ width: '100%', height: 64, objectFit: 'cover', display: 'block' }} />
            )}
            {/* 悬停预览提示 */}
            <div style={{
              position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', fontSize: 12, background: 'rgba(0,0,0,0.25)', opacity: 0, transition: 'opacity 0.15s',
            }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = '1' }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = '0' }}>
              {isVideo ? '▶ 点击播放' : '🔍 点击预览'}
            </div>
          </div>
          <Button size="mini" status="danger" shape="circle" icon={<IconDelete />}
            style={{ position: 'absolute', top: 4, right: 4, width: 20, height: 20, minWidth: 20 }}
            onClick={(e) => { e.stopPropagation(); onChange(undefined) }} />
        </div>
      ) : (
        <Upload accept={accept} showUploadList={false}
          customRequest={(option: any) => { handleUpload(option.file as File); option.onSuccess?.({}) }}>
          <Button size="small" type="dashed" long icon={<IconUpload />}>
            上传{isVideo ? '参考视频' : '参考图'}
          </Button>
        </Upload>
      )}

      {/* 点击放大预览 */}
      <Modal
        visible={!!previewSrc}
        onCancel={() => setPreviewSrc(null)}
        footer={null}
        style={{ width: 'auto', maxWidth: '90vw' }}
      >
        {previewSrc && (isVideo ? (
          <video src={previewSrc} controls autoPlay
            style={{ width: '100%', maxHeight: '80vh', background: '#000', display: 'block' }} />
        ) : (
          <img src={previewSrc} alt="预览"
            style={{ width: '100%', maxHeight: '80vh', objectFit: 'contain', display: 'block' }} />
        ))}
      </Modal>
    </div>
  )
}

export default NodeRefUpload
