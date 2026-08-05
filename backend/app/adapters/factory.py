"""
Adapter Factory - 适配器工厂

根据 AIModel(provider/type) 动态选择适配器.
- provider=zhipu → ZhipuAdapter（CogView 文生图 + CogVideoX 视频，真实产出）
- provider=placeholder 或其他 → PlaceholderAdapter（占位，便于联调）

配置来源优先级（统一管理的关键）：
1. 后台 AIModel 表（/admin/models 配置，最高优先级）
2. settings.LLM_* 环境变量（兜底）
3. PlaceholderAdapter（都没配时）
"""
import logging
from typing import Optional, Dict, Any, TYPE_CHECKING

from app.adapters.base import BaseAdapter
from app.adapters.placeholder import PlaceholderAdapter

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

# 单例缓存(placeholder 无状态)
_placeholder: Optional[PlaceholderAdapter] = None
# 适配器缓存：按配置指纹缓存，避免重复构造。改了后台配置需重启进程或调 invalidate_adapter_cache
_adapter_cache: Dict[str, "BaseAdapter"] = {}

# task_type → AIModel.type 映射（task_type 是 creation 的业务类型，AIModel.type 是后台配置类型）
_TASK_TO_MODEL_TYPE = {
    "fusion": "text_to_image",
    "image": "text_to_image",
    "image_to_video": "image_to_video",
    "first_last_frame": "image_to_video",
    "lip_sync": "tts",       # 对口型暂复用 tts 类配置
    "tts": "tts",
    "image_edit": "text_to_image",
}


def invalidate_adapter_cache() -> None:
    """清除适配器缓存（后台改了模型配置后调用，让下次取新配置）。"""
    global _placeholder
    _adapter_cache.clear()
    _placeholder = None
    logger.info("[AdapterFactory] adapter cache invalidated")


def get_adapter(model_config: Optional[Dict[str, Any]] = None) -> BaseAdapter:
    """获取适配器（同步，基于已知的 model_config 字典）。

    model_config: AIModel 序列化后的 dict(provider/endpoint/api_key/config/type...).
    provider=zhipu 时返回真实 ZhipuAdapter；其余回退 placeholder。
    """
    global _placeholder
    provider = (model_config or {}).get("provider", "placeholder")
    name = (model_config or {}).get("name", "unknown")

    # 智谱真实适配器（CogView 文生图 + CogVideoX 图生视频）
    if provider in ("zhipu", "glm"):
        from app.adapters.zhipu_adapter import ZhipuAdapter
        cache_key = f"zhipu:{(model_config or {}).get('api_key', '')[-8:]}:{name}"
        if cache_key not in _adapter_cache:
            _adapter_cache[cache_key] = ZhipuAdapter(model_config)
            logger.info(f"[AdapterFactory] ZhipuAdapter 已加载 (provider={provider}/{name})")
        return _adapter_cache[cache_key]

    # MiniMax H3 适配器（图生视频 / 文生视频 / 首尾帧）
    if provider in ("minimax", "h3", "hailuo"):
        from app.adapters.minimax_adapter import MinimaxAdapter
        cache_key = f"minimax:{(model_config or {}).get('api_key', '')[-8:]}:{name}"
        if cache_key not in _adapter_cache:
            _adapter_cache[cache_key] = MinimaxAdapter(model_config)
            logger.info(f"[AdapterFactory] MinimaxAdapter 已加载 (provider={provider}/{name})")
        return _adapter_cache[cache_key]

    # cloud_api / comfyui 等：保留骨架，暂未实现 → 回退 placeholder
    if provider != "placeholder":
        logger.debug(f"[AdapterFactory] '{provider}/{name}' 未实现真实适配器，回退 PlaceholderAdapter")

    if _placeholder is None:
        _placeholder = PlaceholderAdapter(model_config)
    return _placeholder


async def get_adapter_for_task_type(
    task_type: str,
    model_config: Optional[Dict[str, Any]] = None,
    db: "Optional[AsyncSession]" = None,
) -> BaseAdapter:
    """按任务类型选适配器（统一管理入口）。

    配置来源优先级：
    1. 显式传入的 model_config（最高）
    2. 后台 AIModel 表（按 task_type 映射到 model_type 查最高优先级的启用记录）
    3. settings.LLM_* 环境变量（兜底）
    4. PlaceholderAdapter
    """
    # 1. 显式传入优先
    if model_config is not None:
        return get_adapter(model_config)

    # 2. 从后台 AIModel 表查
    if db is not None:
        mc = await _find_model_config_from_db(task_type, db)
        if mc is not None:
            return get_adapter(mc)

    # 3. 环境变量兜底
    from app.core.config import settings
    if getattr(settings, "LLM_API_KEY", None) and getattr(settings, "LLM_PROVIDER", "") == "zhipu":
        return get_adapter({
            "provider": "zhipu",
            "api_key": settings.LLM_API_KEY,
            "endpoint": settings.LLM_BASE_URL or "https://open.bigmodel.cn/api/paas/v4",
        })

    # 4. 占位
    return get_adapter(None)


async def _find_model_config_from_db(task_type: str, db: "AsyncSession") -> Optional[Dict[str, Any]]:
    """按 task_type 映射到 AIModel.type，查最高优先级的启用记录，返回序列化 dict。"""
    model_type = _TASK_TO_MODEL_TYPE.get(task_type)
    if not model_type:
        return None
    try:
        from sqlalchemy import select
        from app.models import AIModel
        result = await db.execute(
            select(AIModel)
            .where(AIModel.type == model_type, AIModel.is_enabled == True)
            .order_by(AIModel.priority.desc(), AIModel.created_at.desc())
            .limit(1)
        )
        m = result.scalar_one_or_none()
        if m is None:
            return None
        # 序列化为适配器认识的 dict 格式
        return {
            "id": m.id,
            "name": m.name,
            "type": m.type,
            "provider": m.provider,
            "endpoint": m.endpoint,
            "api_key": m.api_key,
            "config": m.config or {},
            "is_enabled": m.is_enabled,
            "priority": m.priority,
        }
    except Exception as e:
        logger.warning(f"查询 AIModel(type={model_type}) 失败，回退环境变量: {e}")
        return None

