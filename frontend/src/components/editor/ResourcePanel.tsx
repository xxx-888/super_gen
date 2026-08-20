/**
 * ResourcePanel - 资源面板
 *
 * 显示当前项目的所有可用资源(角色/场景/道具/音频)
 * 支持点击插入到提示词中
 */
import React, { useEffect, useState } from 'react'
import { Tabs, Empty, Spin, Input, Space, Modal, Form, Button } from '@arco-design/web-react'
import {
  IconPlus,
  IconSearch,
  IconUser,
  IconImage,
  IconApps,
  IconMusic,
} from '@arco-design/web-react/icon'

import { useResourcePanelStore } from '@/stores'
import { apiClient } from '@/api/client'
import type { ResourceType, Character, SceneBackground, Prop, AudioAsset } from '@/types'

interface ResourcePanelProps {
  onInsertMention: (item: any) => void
}

const TabIcon = ({ type }: { type: ResourceType }) => {
  switch (type) {
    case 'character':
      return <IconUser />
    case 'scene_bg':
      return <IconImage />
    case 'prop':
      return <IconApps />
    case 'audio':
      return <IconMusic />
    default:
      return null
  }
}

const ResourcePanel: React.FC<ResourcePanelProps> = ({ onInsertMention }) => {
  const {
    activeTab,
    searchQuery,
    characters,
    sceneBackgrounds,
    props: propItems,
    audioAssets,
    setActiveTab,
    setSearchQuery,
    setCharacters,
    setSceneBackgrounds,
    setProps,
    setAudioAssets,
  } = useResourcePanelStore()

  const [loading, setLoading] = useState(false)
  const [projectId] = useState(() => {
    // 从URL获取projectId
    const match = window.location.pathname.match(/\/projects\/([^/]+)/)
    return match ? match[1] : ''
  })

  // 加载资源数据
  useEffect(() => {
    if (projectId) {
      loadResources()
    }
  }, [projectId])

  const loadResources = async () => {
    setLoading(true)
    try {
      const [chars, bgs, propsData, audios] = await Promise.all([
        apiClient.get(`/projects/${projectId}/characters`),
        apiClient.get(`/projects/${projectId}/scenes-bg`),
        apiClient.get(`/projects/${projectId}/props`),
        apiClient.get(`/projects/${projectId}/audio`),
      ])

      setCharacters(chars.data || [])
      setSceneBackgrounds(bgs.data || [])
      setProps(propsData.data || [])
      setAudioAssets(audios.data || [])
    } catch (error) {
      console.error('Failed to load resources:', error)
    } finally {
      setLoading(false)
    }
  }

  // 过滤资源
  const filterResources = (resources: any[]) => {
    if (!searchQuery.trim()) return resources
    const query = searchQuery.toLowerCase()
    return resources.filter(
      (r) =>
        r.name?.toLowerCase().includes(query) ||
        r.description?.toLowerCase().includes(query)
    )
  }

  // 处理点击资源
  const handleResourceClick = (item: any, type: ResourceType) => {
    onInsertMention({ ...item, resourceType: type })
  }

  // 新建资源(简化版，实际应该打开Modal或跳转页面)
  const handleAddResource = (type: ResourceType) => {
    // TODO: 打开新建资源的Modal
    console.log('Add new resource:', type)
  }

  // 渲染资源卡片网格
  const renderResourceGrid = (
    resources: any[],
    type: ResourceType,
    emptyText: string
  ) => {
    const filtered = filterResources(resources)

    if (filtered.length === 0 && !loading) {
      return <Empty description={emptyText} />
    }

    return (
      <div className="resource-grid">
        {/* 添加按钮 */}
        <div className="resource-add-btn" onClick={() => handleAddResource(type)}>
          <IconPlus style={{ fontSize: 20 }} />
          <span style={{ fontSize: 11, marginTop: 4 }}>新增</span>
        </div>

        {filtered.map((item) => (
          <div
            key={item.id}
            className="resource-card"
            onClick={() => handleResourceClick(item, type)}
          >
            {/* 图片预览 */}
            {item.image_url ? (
              <img
                src={item.image_url}
                alt={item.name}
                className="resource-card-image"
              />
            ) : (
              <div
                style={{
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: '#F7F8FA',
                  fontSize: 24,
                  color: '#C9CDD4',
                }}
              >
                <TabIcon type={type} />
              </div>
            )}

            {/* 名称 */}
            <div className="resource-card-name">{item.name}</div>
          </div>
        ))}
      </div>
    )
  }

  const tabItems = [
    {
      key: 'all',
      label: '全部',
      children: (
        <div>
          {renderResourceGrid(characters, 'character', '暂无角色')}
          {renderResourceGrid(sceneBackgrounds, 'scene_bg', '暂无场景')}
          {renderResourceGrid(propItems, 'prop', '暂无道具')}
          {renderResourceGrid(audioAssets, 'audio', '暂无音频')}
        </div>
      ),
    },
    {
      key: 'character',
      label: (
        <Space size={4}>
          <TabIcon type="character" />
          角色
          <span style={{
            background: '#F2F3F5',
            borderRadius: 10,
            padding: '0 6px',
            fontSize: 11,
          }}>
            {characters.length}
          </span>
        </Space>
      ),
      children: renderResourceGrid(characters, 'character', '暂无角色'),
    },
    {
      key: 'scene_bg',
      label: (
        <Space size={4}>
          <TabIcon type="scene_bg" />
          场景
          <span style={{
            background: '#F2F3F5',
            borderRadius: 10,
            padding: '0 6px',
            fontSize: 11,
          }}>
            {sceneBackgrounds.length}
          </span>
        </Space>
      ),
      children: renderResourceGrid(sceneBackgrounds, 'scene_bg', '暂无场景'),
    },
    {
      key: 'prop',
      label: (
        <Space size={4}>
          <TabIcon type="prop" />
          道具
          <span style={{
            background: '#F2F3F5',
            borderRadius: 10,
            padding: '0 6px',
            fontSize: 11,
          }}>
            {propItems.length}
          </span>
        </Space>
      ),
      children: renderResourceGrid(propItems, 'prop', '暂无道具'),
    },
    {
      key: 'audio',
      label: (
        <Space size={4}>
          <TabIcon type="audio" />
          音频
          <span style={{
            background: '#F2F3F5',
            borderRadius: 10,
            padding: '0 6px',
            fontSize: 11,
          }}>
            {audioAssets.length}
          </span>
        </Space>
      ),
      children: renderResourceGrid(audioAssets, 'audio', '暂无音频'),
    },
  ]

  return (
    <div className="resource-panel">
      {/* 搜索框 */}
      <Input
        placeholder="搜索资源..."
        prefix={<IconSearch />}
        value={searchQuery}
        onChange={(value) => setSearchQuery(value)}
        allowClear
        style={{ marginBottom: 16 }}
      />

      {/* 标签页 */}
      <Tabs
        activeTab={activeTab}
        onChange={(key) => setActiveTab(key as ResourceType | 'all')}
        size="small"
        style={{ marginTop: -16 }} /* 抵消padding */
      >
        {tabItems.map((item) => (
          <Tabs.TabPane key={item.key} title={item.label}>
            {item.children}
          </Tabs.TabPane>
        ))}
      </Tabs>

      {/* 加载状态 */}
      {loading && (
        <div style={{ textAlign: 'center', padding: 20 }}>
          <Spin />
        </div>
      )}
    </div>
  )
}

export default ResourcePanel
