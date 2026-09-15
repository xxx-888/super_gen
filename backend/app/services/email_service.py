"""
邮件发送服务 —— SMTP 基础设施 (平台此前无任何邮件能力, 本模块补齐)

配置来源: 后台「系统设置」(system_settings 表, 经 settings_service 读取)。
  smtp_host / smtp_port / smtp_user / smtp_password / smtp_ssl / smtp_from_name
未配置或发送失败均只记日志、绝不抛异常影响主业务流程(通知站内已落库, 邮件是增强)。

发送统一走 asyncio.to_thread 包装 smtplib, 不阻塞事件循环。
"""
import asyncio
import logging
import smtplib
from email.header import Header
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession

from app.services.settings_service import get_setting

logger = logging.getLogger(__name__)

# system_settings 中的键
KEY_HOST = "smtp_host"
KEY_PORT = "smtp_port"
KEY_USER = "smtp_user"
KEY_PASSWORD = "smtp_password"
KEY_SSL = "smtp_ssl"           # True=465 SSL, False=587 STARTTLS
KEY_FROM_NAME = "smtp_from_name"


async def get_smtp_config(db: AsyncSession) -> Optional[dict]:
    """读取 SMTP 配置; 未配置完整(host+user+password)返回 None。"""
    cfg = {
        "host": await get_setting(db, KEY_HOST),
        "port": await get_setting(db, KEY_PORT, 465),
        "user": await get_setting(db, KEY_USER),
        "password": await get_setting(db, KEY_PASSWORD),
        "ssl": await get_setting(db, KEY_SSL, True),
        "from_name": await get_setting(db, KEY_FROM_NAME) or "AI短剧生成平台",
    }
    if not (cfg["host"] and cfg["user"] and cfg["password"]):
        return None
    try:
        cfg["port"] = int(cfg["port"] or 465)
    except (TypeError, ValueError):
        cfg["port"] = 465
    return cfg


def _send_sync(cfg: dict, to_email: str, subject: str, html: str) -> bool:
    """同步发送(在线程池里跑)。返回是否成功。"""
    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = Header(subject, "utf-8")
        msg["From"] = formataddr((str(Header(cfg["from_name"], "utf-8")), cfg["user"]))
        msg["To"] = to_email
        msg.attach(MIMEText(html, "html", "utf-8"))

        if cfg["ssl"]:
            server = smtplib.SMTP_SSL(cfg["host"], cfg["port"], timeout=15)
        else:
            server = smtplib.SMTP(cfg["host"], cfg["port"], timeout=15)
            try:
                server.starttls()
            except smtplib.SMTPException:
                pass  # 部分内网中继不支持 STARTTLS, 继续明文(少见)
        try:
            server.login(cfg["user"], cfg["password"])
            server.sendmail(cfg["user"], [to_email], msg.as_string())
            return True
        finally:
            try:
                server.quit()
            except Exception:
                pass
    except Exception as e:
        logger.error(f"[Email] 发送失败 to={to_email} subject={subject}: {e}")
        return False


async def send_email(db: AsyncSession, to_email: str, subject: str, html: str) -> bool:
    """发送邮件(读配置 + 线程池发送)。未配置/失败返回 False, 不抛异常。"""
    if not to_email:
        return False
    cfg = await get_smtp_config(db)
    if not cfg:
        logger.info(f"[Email] SMTP 未配置, 跳过邮件: to={to_email} subject={subject}")
        return False
    return await asyncio.to_thread(_send_sync, cfg, to_email, subject, html)


# ==================== 业务邮件模板 ====================

def _wrap(title: str, body_html: str) -> str:
    return f"""<div style="max-width:560px;margin:0 auto;font-family:'PingFang SC','Microsoft YaHei',sans-serif;color:#1d2129;">
  <h2 style="font-size:18px;border-bottom:1px solid #eee;padding-bottom:12px;">{title}</h2>
  <div style="font-size:14px;line-height:1.8;">{body_html}</div>
  <p style="font-size:12px;color:#86909c;margin-top:28px;border-top:1px solid #eee;padding-top:12px;">
    本邮件由系统自动发送，请勿直接回复。如非本人操作请忽略。
  </p>
</div>"""


def tpl_generation_done(nickname: str, task_desc: str, ok: bool, detail: str = "") -> str:
    if ok:
        body = f"<p>{nickname}，你好！</p><p>你提交的生成任务已完成 ✅</p><p><b>任务：</b>{task_desc}</p>"
        return _wrap("生成任务完成", body)
    body = (f"<p>{nickname}，你好！</p><p>你提交的生成任务未能完成 ❌</p>"
            f"<p><b>任务：</b>{task_desc}</p><p><b>原因：</b>{detail or '未知'}</p>"
            f"<p>任务积分已自动退还，可重新提交。</p>")
    return _wrap("生成任务失败通知", body)


def tpl_recharge_success(nickname: str, order_no: str, credits: int, amount_yuan: str) -> str:
    body = (f"<p>{nickname}，你好！</p><p>你的充值已到账 ✅</p>"
            f"<p><b>订单号：</b>{order_no}<br/><b>充值金额：</b>¥{amount_yuan}<br/>"
            f"<b>到账积分：</b>{credits}</p>")
    return _wrap("充值成功通知", body)


def tpl_invoice_result(nickname: str, order_no: str, ok: bool, note: str = "") -> str:
    if ok:
        body = (f"<p>{nickname}，你好！</p><p>你的发票申请已处理完成 ✅</p>"
                f"<p><b>订单号：</b>{order_no}</p><p>发票将发送至本邮箱，请注意查收。</p>")
        return _wrap("发票已开具", body)
    body = (f"<p>{nickname}，你好！</p><p>你的发票申请未能通过 ❌</p>"
            f"<p><b>订单号：</b>{order_no}</p><p><b>原因：</b>{note or '信息有误'}</p>"
            f"<p>驳回后可修改信息重新申请。</p>")
    return _wrap("发票申请审核结果", body)
