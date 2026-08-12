"""
ORM Models - 画布面板 (Canvas Panel)

节点画布编辑器：用户可在一个画布上拖入节点、连线建立数据流，
纯手搓出完整视频。对标 liblib.tv 的画布创作流程。

- Canvas(画布): 项目级，一个项目可以有多个画布
- graph_data 用 JSONB 整存整取 React Flow 的 {nodes, edges} 结构
  (拆 CanvasNode/CanvasEdge 两表会引入复杂同步，且画布无节点级查询需求)
"""
from uuid import uuid4
from sqlalchemy import Column, String, Text, Integer, ForeignKey, Index
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship

from app.models import Base, TimestampMixin


class Canvas(Base, TimestampMixin):
    """画布 - 节点画布编辑器的一个画布工作区"""
    __tablename__ = "canvases"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False)
    # 多租户隔离：归属团队(沿用 Project.org_id 的做法)
    org_id = Column(UUID(as_uuid=True), ForeignKey("organizations.id"), index=True)
    # 创建者
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)

    name = Column(String(255), nullable=False, default="未命名画布")
    # React Flow 结构 {nodes: [...], edges: [...]}，整存整取
    graph_data = Column(JSONB, default=dict)
    # 画布缩略图(可选，自动截图)
    thumbnail_url = Column(Text)
    # 乐观锁版本号
    version = Column(Integer, default=1, nullable=False)
    # 扩展字段：如 last_opened、node_count 等
    meta = Column(JSONB, default=dict)

    # 关系
    project = relationship("Project")
    org = relationship("Organization")
    owner = relationship("User")

    __table_args__ = (
        Index("ix_canvas_project", "project_id"),
    )

    def __repr__(self):
        return f"<Canvas {self.name} v{self.version}>"
