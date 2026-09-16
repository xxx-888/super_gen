"""剧本模板（M9 模板库）。

与「官方示例项目」（Project.is_template，含完整分镜树，一键克隆）互补：
剧本模板只是「按题材分类的剧本正文 + 推荐角色设定」，用户选定后
一键创建项目并预填剧本正文，之后走正常的 AI 解析 → 分镜流程。

注意与 PromptTemplate（AI 提示词模板）区分：两者用途完全不同。
"""
from sqlalchemy import Boolean, Column, Integer, String, Text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB

from app.models import Base, TimestampMixin


class ScriptTemplate(Base, TimestampMixin):
    """剧本模板表"""
    __tablename__ = "script_templates"

    # 稳定字符串主键（seed 数据用它做幂等 upsert，如 'urban-romance-1'）
    id = Column(String(64), primary_key=True)
    genre = Column(String(50), nullable=False, index=True)  # 题材（分组维度）
    title = Column(String(255), nullable=False)             # 模板名，如《咖啡厅的心动预告》
    logline = Column(String(500))                           # 一句话梗概
    description = Column(Text)                              # 适用场景/亮点说明
    tags = Column(ARRAY(Text), default=list)                # 标签（如 反转、甜宠、爽感）
    content = Column(Text, nullable=False)                  # 剧本正文（可直接交给 AI 解析）
    # 推荐角色设定 [{name, role, appearance_prompt}]（仅展示参考，不直接入库）
    characters = Column(JSONB, default=list)
    episode_count = Column(Integer, default=1)              # 建议拆分集数
    use_count = Column(Integer, default=0)                  # 被使用次数
    sort_order = Column(Integer, default=0)
    is_active = Column(Boolean, default=True)               # 下架开关（后台管理）

    def __repr__(self):
        return f"<ScriptTemplate {self.id} [{self.genre}]>"
