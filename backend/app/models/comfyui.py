"""ComfyUI 工作流库（M8）

ComfyUIWorkflow: 导入的 ComfyUI 工作流 JSON（UI 格式或 API 格式），
解析出的元信息（节点统计/模型名/输入节点），可导出为 ComfyUI 可直接
执行的格式（API 格式 POST /prompt；UI 格式加载进编辑器）。
后续 comfyui 适配器直接按 id 取 graph 执行。
"""
import uuid

from sqlalchemy import Boolean, Column, Integer, String, Text, UUID
from sqlalchemy.dialects.postgresql import JSONB

from app.models import Base, TimestampMixin


class ComfyUIWorkflow(Base, TimestampMixin):
    """ComfyUI 工作流。format: 'ui'（编辑器格式，含 nodes/links）或 'api'（/prompt 执行格式）"""
    __tablename__ = "comfyui_workflows"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(120), nullable=False)
    description = Column(Text)
    format = Column(String(8), nullable=False, default="ui")   # ui / api
    graph = Column(JSONB, nullable=False, default=dict)        # 原始工作流 JSON
    meta = Column(JSONB, default=dict)                         # 解析出的元信息
    node_count = Column(Integer, default=0)
    is_enabled = Column(Boolean, default=True, nullable=False)

    def __repr__(self):
        return f"<ComfyUIWorkflow {self.name} ({self.format}/{self.node_count}n)>"
