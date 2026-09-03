"""
Captcha API - 点选人机验证（公开，挂在 /auth/captcha 下）

用途：给 POST /auth/sms/send-code 加前置人机验证，防止脚本直打接口
批量发短信/恶意注册。流程：
  1. GET  /auth/captcha/challenge?purpose=xxx —— 服务端取 6 个汉字随机
     摆位生成 SVG，随机选 3 个作为按序点击目标；位置/目标存 Redis
     （TTL 180s，最多错 6 次）
  2. POST /auth/captcha/verify {captcha_id, points} —— 依次校验 3 个
     点击坐标与目标字中心距离；通过则发一次性 captcha_token
     （TTL 600s，与 purpose 绑定）
  3. POST /auth/sms/send-code 携带 captcha_token —— 校验用途并消费

说明：SVG 方案字符位置理论上可被程序解析，属「挡直打接口 + 挡低门槛
脚本」级别；后续可升级 Pillow 图片扭曲/专业行为验证（腾讯云/极验）。
"""
import json
import logging
import random
import secrets
import uuid
from datetime import date

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.exceptions import BadRequestException, RateLimitException
from app.core.redis import get_redis

logger = logging.getLogger(__name__)

router = APIRouter()

# 视觉差异大、常用、单字
CHAR_POOL = list("日月水火山石田禾米竹雨星风云雪电光花鸟鱼虫马牛羊兔龙凤舟车门窗琴棋书画茶酒灯伞桥钟镜")

_W, _H = 300, 120          # SVG 画布（前端按此尺寸渲染，点击坐标一致）
_TOL = 26                  # 点击容差(px)
_CH_TTL = 180              # 挑战有效期
_TOKEN_TTL = 600           # 验证通过 token 有效期
_MAX_FAILS = 6             # 单挑战最大尝试次数

VALID_PURPOSES = ("register", "reset_password")


def _client_ip(request: Request) -> str:
    # 单层可信 nginx 反代：XFF 最后一段是真实连接 IP（客户端可伪造前面的段）
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[-1].strip()[:64]
    return request.client.host if request.client else "unknown"


def _gen_svg(chars, positions) -> str:
    """生成点选验证码 SVG：底纹 + 干扰弧线 + 6 个随机旋转/配色汉字"""
    palette = ["#334455", "#4a5d75", "#5b4a63", "#3d6355", "#6b4a4a", "#45577a"]
    texts = []
    for ch, (x, y), color in zip(chars, positions, random.sample(palette, len(chars))):
        rot = random.randint(-28, 28)
        size = random.choice([26, 28, 30])
        dy = random.randint(-2, 2)
        texts.append(
            f'<text x="{x}" y="{y + dy}" font-size="{size}" fill="{color}" '
            f'font-family="PingFang SC, Microsoft YaHei, sans-serif" font-weight="600" '
            f'text-anchor="middle" dominant-baseline="central" '
            f'transform="rotate({rot} {x} {y})">{ch}</text>'
        )
    noise = []
    for _ in range(5):
        x1, y1 = random.randint(0, _W), random.randint(0, _H)
        cx, cy = random.randint(0, _W), random.randint(0, _H)
        x2, y2 = random.randint(0, _W), random.randint(0, _H)
        noise.append(
            f'<path d="M{x1} {y1} Q{cx} {cy} {x2} {y2}" stroke="#c9d2dd" '
            f'stroke-width="{random.choice([1, 1.5, 2])}" fill="none" opacity="0.6"/>'
        )
    dots = "".join(
        f'<circle cx="{random.randint(5, _W - 5)}" cy="{random.randint(5, _H - 5)}" '
        f'r="{random.uniform(0.6, 1.6):.1f}" fill="#aeb9c6" opacity="0.7"/>'
        for _ in range(14)
    )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{_W}" height="{_H}" '
        f'viewBox="0 0 {_W} {_H}" style="user-select:none">'
        f'<rect width="{_W}" height="{_H}" rx="8" fill="#f2f5f9"/>'
        + "".join(noise) + dots + "".join(texts) + "</svg>"
    )


@router.get("/challenge")
async def get_captcha_challenge(
    purpose: str = Query(..., description="register / reset_password"),
    request: Request = None,
):
    """获取点选验证码挑战（SVG + 按序点击目标字）"""
    if purpose not in VALID_PURPOSES:
        raise BadRequestException("不支持的验证用途")

    ip = _client_ip(request)
    try:
        redis = get_redis()
        # 同 IP 3s 冷却 + 每日 150 次，防批量拉挑战
        cd = f"captcha:cd:{ip}"
        if await redis.exists(cd):
            raise RateLimitException("操作太频繁，请稍后再试")
        daily = f"captcha:daily:{ip}:{date.today().isoformat()}"
        cnt = await redis.incr(daily)
        if cnt == 1:
            await redis.expire(daily, 86400)
        if cnt > 150:
            raise RateLimitException("今日验证次数已达上限，请明天再试")
        await redis.set(cd, "1", ex=3)
    except (BadRequestException, RateLimitException):
        raise
    except Exception as e:
        logger.warning(f"验证码限流检查失败(忽略): {e}")

    chars = random.sample(CHAR_POOL, 6)
    positions = []
    for row in range(2):          # 3×2 网格 + 抖动，避免重叠
        for col in range(3):
            positions.append((
                50 + col * 100 + random.randint(-16, 16),
                30 + row * 60 + random.randint(-8, 8),
            ))
    target_idx = random.sample(range(6), 3)   # 按序点击的 3 个字

    captcha_id = uuid.uuid4().hex
    payload = {
        "positions": positions,
        "target_idx": target_idx,
        "purpose": purpose,
        "fails": 0,
    }
    try:
        redis = get_redis()
        await redis.set(f"captcha:ch:{captcha_id}", json.dumps(payload), ex=_CH_TTL)
    except Exception as e:
        logger.error(f"验证码挑战写入 Redis 失败: {e}")
        raise BadRequestException("验证码服务暂不可用，请稍后重试")

    return {
        "captcha_id": captcha_id,
        "svg": _gen_svg(chars, positions),
        "targets": [chars[i] for i in target_idx],
        "expires_in": _CH_TTL,
    }


class CaptchaVerifyRequest(BaseModel):
    """点选验证提交：按顺序的 3 个点击坐标（SVG 画布坐标系）"""
    captcha_id: str = Field(..., min_length=8, max_length=64)
    points: list = Field(..., min_length=3, max_length=3,
                         description="[[x,y],[x,y],[x,y]] 按目标顺序")


@router.post("/verify")
async def verify_captcha(body: CaptchaVerifyRequest):
    """校验点选坐标。通过发一次性 captcha_token（10 分钟内用于 send-code）"""
    redis = get_redis()
    raw = None
    try:
        raw = await redis.get(f"captcha:ch:{body.captcha_id}")
    except Exception as e:
        logger.error(f"验证码读取 Redis 失败: {e}")
        raise BadRequestException("验证码服务暂不可用，请稍后重试")

    if not raw:
        raise BadRequestException("验证码已过期，请点击「换一张」重新验证")
    payload = json.loads(raw)

    if payload.get("fails", 0) >= _MAX_FAILS:
        await redis.delete(f"captcha:ch:{body.captcha_id}")
        raise BadRequestException("错误次数过多，请刷新验证码重试")

    ok = True
    for i, pt in enumerate(body.points):
        try:
            x, y = float(pt[0]), float(pt[1])
        except (TypeError, ValueError, IndexError):
            ok = False
            break
        tx, ty = payload["positions"][payload["target_idx"][i]]
        if abs(x - tx) > _TOL or abs(y - ty) > _TOL:
            ok = False
            break

    if not ok:
        payload["fails"] = payload.get("fails", 0) + 1
        # 重新写入（重置 TTL 可接受：错 6 次即作废）
        await redis.set(f"captcha:ch:{body.captcha_id}", json.dumps(payload), ex=_CH_TTL)
        raise BadRequestException("验证未通过，请按文字顺序重新点击")

    # 通过：删挑战 + 发一次性 token（绑定用途）
    await redis.delete(f"captcha:ch:{body.captcha_id}")
    token = uuid.uuid4().hex
    try:
        await redis.set(f"captcha:ok:{token}", payload["purpose"], ex=_TOKEN_TTL)
    except Exception as e:
        logger.error(f"验证 token 写入失败: {e}")
        raise BadRequestException("验证码服务暂不可用，请稍后重试")
    return {"captcha_token": token, "expires_in": _TOKEN_TTL}


async def consume_captcha_token(token: str, purpose: str) -> None:
    """send-code 前消费一次性验证 token；不存在/用途不符则抛错"""
    if not token:
        raise BadRequestException("请先完成人机验证")
    redis = get_redis()
    key = f"captcha:ok:{token}"
    try:
        stored = await redis.get(key)
    except Exception as e:
        logger.error(f"验证 token 读取失败: {e}")
        raise BadRequestException("验证码服务暂不可用，请稍后重试")
    if not stored:
        raise BadRequestException("人机验证已失效，请重新验证")
    if stored != purpose:
        raise BadRequestException("人机验证与当前操作不匹配，请重新验证")
    await redis.delete(key)   # 一次性消费
