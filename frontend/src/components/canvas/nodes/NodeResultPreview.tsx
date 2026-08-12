/**
 * NodeResultPreview - 节点结果预览
 *
 * 生成完成后在节点内显示缩略图/视频/音频。
 * - 图片：contain 完整显示（不裁剪），点击放大预览
 * - 视频：缩略图 + 播放图标，点击全屏播放
 * - 音频：播放条
 */
import React from 'react'
import { Modal } from '@arco-design/web-react'
import { IconImage, IconVideoCamera, IconSound, IconRefresh } from '@arco-design/web-react/icon'

export const NodeResultPreview: React.FC<{
  urls?: string[]
  type: 'image' | 'video' | 'audio'
  /** 重新生成回调（可选） */
  onRegenerate?: () => void
}> = ({ urls = [], type, onRegenerate }) => {
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null)
  if (!urls.length) return null

  // 音频只显示播放条
  if (type === 'audio') {
    return (
      <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {urls.map((u, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <IconSound style={{ color: 'rgb(var(--primary-6))', fontSize: 14 }} />
            <audio controls src={u} style={{ height: 24, flex: 1, maxWidth: 200 }} />
          </div>
        ))}
        {onRegenerate && (
          <div style={{ marginTop: 2, textAlign: 'center' }}>
            <span onClick={onRegenerate} style={{ fontSize: 11, color: 'rgb(var(--primary-6))', cursor: 'pointer' }}>
              <IconRefresh style={{ marginRight: 2 }} />重新生成
            </span>
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {urls.map((u, i) => {
          const isVideo = type === 'video' || /\.(mp4|webm|mov)(\?|$)/i.test(u)
          return (
            <div key={i}>
              <div
                style={{
                  width: '100%',
                  aspectRatio: isVideo ? '16/9' : '4/3',
                  borderRadius: 6,
                  overflow: 'hidden',
                  background: 'var(--color-fill-2)',
                  cursor: 'zoom-in',
                  border: '1px solid var(--color-border)',
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  // 棋盘格背景让透明图片的留白区可见
                  backgroundImage:
                    'linear-gradient(45deg, var(--color-fill-3) 25%, transparent 25%),' +
                    'linear-gradient(-45deg, var(--color-fill-3) 25%, transparent 25%),' +
                    'linear-gradient(45deg, transparent 75%, var(--color-fill-3) 75%),' +
                    'linear-gradient(-45deg, transparent 75%, var(--color-fill-3) 75%)',
                  backgroundSize: '12px 12px',
                  backgroundPosition: '0 0, 0 6px, 6px -6px, -6px 0',
                }}
                onClick={() => setPreviewUrl(u)}
              >
                {isVideo ? (
                  <>
                    <video src={u} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} muted />
                    <IconVideoCamera
                      style={{
                        position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                        color: '#fff', fontSize: 28, filter: 'drop-shadow(0 1px 4px rgba(0,0,0,0.6))',
                      }}
                    />
                  </>
                ) : (
                  <img
                    src={u}
                    alt={`结果${i + 1}`}
                    style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' }}
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                  />
                )}
              </div>
            </div>
          )
        })}
        {onRegenerate && (
          <div style={{ textAlign: 'center' }}>
            <span onClick={onRegenerate} style={{ fontSize: 11, color: 'rgb(var(--primary-6))', cursor: 'pointer' }}>
              <IconRefresh style={{ marginRight: 2, fontSize: 11 }} />重新生成
            </span>
          </div>
        )}
      </div>

      {/* 放大预览 */}
      {previewUrl && (
        <Modal
          visible={!!previewUrl}
          onCancel={() => setPreviewUrl(null)}
          footer={null}
          closable
          style={{ width: 'auto', maxWidth: '85vw' }}
        >
          {/\.(mp4|webm|mov)(\?|$)/i.test(previewUrl) ? (
            <video src={previewUrl} controls autoPlay style={{ maxWidth: '80vw', maxHeight: '75vh' }} />
          ) : (
            <img src={previewUrl} alt="预览" style={{ maxWidth: '78vw', maxHeight: '72vh', objectFit: 'contain' }} />
          )}
        </Modal>
      )}
    </>
  )
}
