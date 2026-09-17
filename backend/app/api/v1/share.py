"""作品公开分享落地页（免登录 view-only + og 卡片）

GET /share/works/{work_id} — 服务器端渲染完整 HTML（无需登录）:
- 爬虫友好的 og/twitter/JSON-LD 元信息 → 微信/抖音/QQ 分享出带图卡片
- 人类访客看到 view-only 播放页: 视频/封面 + 标题/作者/标签 + 「免费创作同款」CTA
- 仅 is_public 作品可访问（私密作品/不存在一律 404 页, 不泄露存在性）
- 每次访问 view_count +1

设计为纯后端 HTML（爬虫不执行 JS, SPA 无法满足 og 抓取）。
部署: nginx 需将 /share/ 反代到后端。
"""
import html as _html
import logging
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db

logger = logging.getLogger(__name__)

router = APIRouter()

_ESC = _html.escape


def _absolute_url(request: Request, url: str) -> str:
    """相对媒体路径 → 绝对 URL（依据反代传递的 proto/host）。"""
    if not url:
        return ""
    if url.startswith(("http://", "https://", "data:")):
        return url
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme or "https"
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    if not url.startswith("/"):
        url = "/" + url
    return f"{proto}://{host}{url}"


def _page_html(request: Request, work, author_name: str) -> str:
    title = _ESC(work.title or "未命名作品")
    desc = _ESC((work.description or "来自 SceneGen AI 短剧生成平台的作品，点开看看，免费创作你的同款。")[:160])
    cover = _absolute_url(request, work.cover_url or "")
    video = _absolute_url(request, work.video_url or "")
    og_image = cover or _absolute_url(request, "/workbench.png")
    page_url = _absolute_url(request, str(request.url.path))
    site_url = _absolute_url(request, "/")
    tags = work.tags or []
    tags_html = "".join(f'<span class="tag">{_ESC(str(t))}</span>' for t in tags[:6])
    dur = f"{int(work.duration)}s" if getattr(work, "duration", None) else ""
    author = _ESC(author_name or "SceneGen 创作者")

    media_html = (
        f'<video controls playsinline preload="metadata" poster="{_ESC(cover)}" src="{_ESC(video)}"></video>'
        if video else
        f'<img src="{_ESC(cover or og_image)}" alt="{title}" />'
    )

    json_ld = json_dumps_safe({
        "@context": "https://schema.org",
        "@type": "VideoObject",
        "name": work.title,
        "description": (work.description or "")[:300],
        "thumbnailUrl": [og_image] if og_image else [],
        "uploadDate": (work.published_at or work.created_at).isoformat() if (work.published_at or work.created_at) else None,
        "contentUrl": video or None,
        "embedUrl": page_url,
        "author": {"@type": "Person", "name": author_name or "SceneGen 创作者"},
    })

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<title>{title} | SceneGen AI短剧</title>
<meta name="description" content="{desc}" />
<meta property="og:type" content="video.other" />
<meta property="og:title" content="{title}" />
<meta property="og:description" content="{desc}" />
<meta property="og:image" content="{_ESC(og_image)}" />
<meta property="og:url" content="{_ESC(page_url)}" />
<meta property="og:site_name" content="SceneGen" />
{f'<meta property="og:video" content="{_ESC(video)}" />' if video else ''}
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="{title}" />
<meta name="twitter:description" content="{desc}" />
<meta name="twitter:image" content="{_ESC(og_image)}" />
<script type="application/ld+json">{json_ld}</script>
<style>
* {{ box-sizing: border-box; margin: 0; padding: 0; }}
body {{ background: #0d0d14; color: #eef0f6; font-family: -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  min-height: 100vh; display: flex; flex-direction: column; align-items: center; }}
.bg-glow {{ position: fixed; inset: 0; pointer-events: none; z-index: 0;
  background: radial-gradient(600px 400px at 50% -100px, rgba(124, 92, 255, .22), transparent 70%); }}
main {{ position: relative; z-index: 1; width: 100%; max-width: 760px; padding: 32px 20px 48px; }}
.brand {{ display: flex; align-items: center; gap: 8px; margin-bottom: 20px; }}
.brand a {{ color: #b9aaff; text-decoration: none; font-weight: 700; font-size: 15px; letter-spacing: .5px; }}
.player {{ border-radius: 16px; overflow: hidden; background: #16161f; border: 1px solid #262633;
  box-shadow: 0 18px 50px rgba(0,0,0,.5); }}
.player video, .player img {{ display: block; width: 100%; max-height: 62vh; object-fit: contain; background: #000; }}
h1 {{ font-size: 22px; line-height: 1.35; margin: 20px 0 6px; }}
.meta {{ color: #8b8ea0; font-size: 13px; display: flex; flex-wrap: wrap; gap: 14px; margin-bottom: 12px; }}
.desc {{ color: #b9bccb; font-size: 14px; line-height: 1.7; margin-bottom: 14px; white-space: pre-wrap; }}
.tags {{ display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 22px; }}
.tag {{ font-size: 12px; color: #b9aaff; background: rgba(124,92,255,.12); border: 1px solid rgba(124,92,255,.3);
  border-radius: 999px; padding: 3px 12px; }}
.cta {{ display: flex; gap: 12px; flex-wrap: wrap; }}
.cta a {{ text-decoration: none; border-radius: 10px; padding: 12px 22px; font-size: 15px; font-weight: 600; }}
.cta .primary {{ background: linear-gradient(135deg, #7c5cff, #a78bfa); color: #fff; }}
.cta .ghost {{ border: 1px solid #34344a; color: #c9ccdd; }}
.hint {{ margin-top: 26px; color: #5d6070; font-size: 12px; text-align: center; }}
@media (max-width: 480px) {{ h1 {{ font-size: 18px; }} }}
</style>
</head>
<body>
<div class="bg-glow"></div>
<main>
  <div class="brand"><a href="{_ESC(site_url)}">✦ SceneGen · AI短剧生成</a></div>
  <div class="player">{media_html}</div>
  <h1>{title}</h1>
  <div class="meta"><span>创作者：{author}</span>{f'<span>时长 {dur}</span>' if dur else ''}<span>👁 {work.view_count or 0}</span></div>
  {f'<p class="desc">{_ESC(work.description or "")}</p>' if work.description else ''}
  {f'<div class="tags">{tags_html}</div>' if tags_html else ''}
  <div class="cta">
    <a class="primary" href="{_ESC(site_url)}register">免费创作同款 →</a>
    <a class="ghost" href="{_ESC(site_url)}videos">浏览更多作品</a>
  </div>
  <p class="hint">本页面由 SceneGen AI 短剧生成平台驱动 · 用 AI 把剧本变成短剧</p>
</main>
</body>
</html>"""


def json_dumps_safe(obj) -> str:
    import json as _json
    try:
        return _json.dumps(obj, ensure_ascii=False, default=str)
    except Exception:
        return "{}"


def _not_found() -> HTMLResponse:
    return HTMLResponse(
        """<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>作品不存在 | SceneGen</title>
<style>body{background:#0d0d14;color:#8b8ea0;font-family:-apple-system,'PingFang SC',sans-serif;
display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px}
a{color:#b9aaff;text-decoration:none;font-weight:600}</style></head>
<body><div style="font-size:44px">🎬</div><p>作品不存在或未公开分享</p>
<a href="/">去 SceneGen 免费创作 →</a></body></html>""",
        status_code=404,
    )


@router.get("/share/works/{work_id}", response_class=HTMLResponse)
async def share_work_page(
    request: Request,
    work_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """作品公开落地页（免登录）。仅 is_public 作品；访问即浏览数 +1。"""
    from app.models import Work, User

    work = (await db.execute(select(Work).where(Work.id == work_id))).scalar_one_or_none()
    if work is None or not work.is_public:
        return _not_found()

    author = (await db.execute(
        select(User.nickname).where(User.id == work.user_id)
    )).scalar_one_or_none()

    # 浏览数 +1（落地页访问口径; 失败不影响出页）
    try:
        await db.execute(
            update(Work).where(Work.id == work.id).values(view_count=(work.view_count or 0) + 1)
        )
        await db.commit()
    except Exception as e:
        logger.warning(f"[Share] view_count 自增失败: {e}")
        await db.rollback()

    return HTMLResponse(_page_html(request, work, author))
