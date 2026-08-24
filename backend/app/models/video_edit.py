"""视频在线剪辑 (M7)

VideoEditConfig: 每集一条的剪辑器配置草稿（JSONB），进项目自动加载；
导出由 ffmpeg 合成（services/video_editor.py），产物地址记在 last_output_url。
"""
import uuid

from sqlalchemy import Boolean, Column, ForeignKey, Text, UUID
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import relationship

from app.models import Base, TimestampMixin


class VideoEditConfig(Base, TimestampMixin):
    """剪辑配置（episode 唯一）。

    config 结构 (v1):
    {
      "version": 1,
      "resolution": {"width": 1280, "height": 720},
      "clips": [
        {"id": "c1", "url": "/uploads/video/...", "name": "分镜1",
         "in": 0.0, "out": 4.4, "volume": 1.0}          # in/out 裁剪秒数; volume 0=静音
      ],
      "audio": {
        "volume": 1.0,                                   # 原声全局音量
        "bgm": {"url": "...", "volume": 0.3, "fade_in": 1.0, "fade_out": 2.0}  # 可空
      },
      "subtitles": [
        {"id": "s1", "start": 0.5, "end": 2.5, "text": "台词"}
      ],
      "subtitle_style": {"font_size": 28, "color": "#FFFFFF", "position": "bottom"}
    }
    """
    __tablename__ = "video_edit_configs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    episode_id = Column(UUID(as_uuid=True), ForeignKey("episodes.id", ondelete="CASCADE"),
                        unique=True, nullable=False, index=True)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"),
                        nullable=False, index=True)
    config = Column(JSONB, default=dict)
    last_output_url = Column(Text)                 # 最近一次导出成片地址
    last_render_task_id = Column(UUID(as_uuid=True),
                                 ForeignKey("generation_tasks.id", ondelete="SET NULL"))
    rendering = Column(Boolean, default=False, nullable=False)  # 导出中标记

    episode = relationship("Episode")

    def __repr__(self):
        return f"<VideoEditConfig episode={self.episode_id} rendering={self.rendering}>"
