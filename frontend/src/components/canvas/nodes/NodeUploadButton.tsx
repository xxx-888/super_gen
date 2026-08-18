/**
 * NodeUploadButton - 画布节点上的"上传资源"按钮
 *
 * 本地上传图片/视频，自动注册为项目资源（与资源管理逻辑一致）：
 * - 视频 → /upload/video → VideoAsset（名称=文件名）
 * - 图片 → /upload/image → 弹窗补类型（角色/场景/道具）+名称 → 对应资源
 * 上传后即可在提示词 @引用 中使用（重开提示词抽屉刷新候选）。
 */
import React, { useState } from 'react'
import { Button, Upload, Modal, Form, Input, Select, Message } from '@arco-design/web-react'
import { IconUpload, IconVideoCamera, IconImage } from '@arco-design/web-react/icon'
import { uploadService, resourceService } from '@/api/services'

interface NodeUploadButtonProps {
  projectId?: string
}

export const NodeUploadButton: React.FC<NodeUploadButtonProps> = ({ projectId }) => {
  const [busy, setBusy] = useState(false)
  // 图片上传后的补充信息弹窗（类型+名称）
  const [imgModalVisible, setImgModalVisible] = useState(false)
  const [imgUrl, setImgUrl] = useState('')
  const [imgForm] = Form.useForm()

  if (!projectId) return null

  const handleFile = async (file: File) => {
    setBusy(true)
    try {
      const isVideo = file.type.startsWith('video/')
      if (isVideo) {
        const res: any = await uploadService.video(file)
        const url = res?.url || res?.data?.url
        if (!url) throw new Error('上传返回缺少 url')
        await resourceService.video.create(projectId, {
          name: file.name.replace(/\.[^.]+$/, ''), url,
        })
        Message.success('视频已上传为项目资源，@引用即可使用（重开提示词抽屉刷新候选）')
      } else {
        const res: any = await uploadService.image(file)
        const url = res?.url || res?.data?.url
        if (!url) throw new Error('上传返回缺少 url')
        setImgUrl(url)
        imgForm.setFieldsValue({ name: file.name.replace(/\.[^.]+$/, '') })
        setImgModalVisible(true)
      }
    } catch { /* 拦截器提示 */ } finally { setBusy(false) }
  }

  const handleImageSave = async () => {
    const fields = await imgForm.validate()
    try {
      const data = { name: fields.name, image_url: imgUrl, prompt: '' }
      if (fields.type === 'character') await resourceService.characters.create(projectId, data)
      else if (fields.type === 'scene_bg') await resourceService.sceneBg.create(projectId, data)
      else await resourceService.props.create(projectId, data)
      Message.success('图片已上传为项目资源，@引用即可使用（重开提示词抽屉刷新候选）')
      setImgModalVisible(false)
    } catch { /* 拦截器提示 */ }
  }

  return (
    <>
      <Upload
        accept="image/*,video/*"
        showUploadList={false}
        customRequest={(option: any) => { handleFile(option.file as File); option.onSuccess?.({}) }}
      >
        <Button size="small" type="dashed" long icon={<IconUpload />} loading={busy}>
          上传图片/视频为资源
        </Button>
      </Upload>

      <Modal
        title="图片保存为资源"
        visible={imgModalVisible}
        onCancel={() => setImgModalVisible(false)}
        onOk={handleImageSave}
        okText="保存"
        cancelText="取消"
      >
        <div style={{ marginBottom: 12, textAlign: 'center' }}>
          <img src={imgUrl} alt="预览" style={{ maxWidth: '100%', maxHeight: 160, borderRadius: 6 }} />
        </div>
        <Form form={imgForm} layout="vertical" initialValues={{ type: 'character' }}>
          <Form.Item field="type" label="资源类型">
            <Select>
              <Select.Option value="character">角色</Select.Option>
              <Select.Option value="scene_bg">场景</Select.Option>
              <Select.Option value="prop">道具</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item field="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="资源名称（@引用时显示）" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}

export default NodeUploadButton
