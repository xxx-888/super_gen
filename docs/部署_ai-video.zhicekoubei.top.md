# ai-video.zhicekoubei.top 部署文档（新服务器 8.137.18.241）

> 2026-11-03 从旧服务器（139.155.135.32，已过期删除）迁至阿里云新机。
> 该机与其他服务共存，**所有资源 supergen-* 前缀隔离，禁止触碰 zckb 系**。

## 服务器拓扑（共存约定）

| 资源 | 归属 | 说明 |
|---|---|---|
| nginx（80/443/8443） | 共用 | 只允许在 `/etc/nginx/conf.d/` 加独立 server block，改前 `nginx -t` |
| `/opt/zckb`、`/opt/zhicekoubei-site`、zckb-* docker 容器（8000/内部 PG+Redis） | 用户其他服务 | **不要动** |
| `/opt/super_gen` | 本项目 | git clone（GitHub 直连可用，无需代理） |
| `/opt/supergen-data` | 本项目数据 | pg/、redis/、webroot/、.secrets（DB 密码） |
| docker 容器 `supergen-pg` | 本项目 | postgres:16-alpine，仅绑 127.0.0.1:**15432** |
| docker 容器 `supergen-redis` | 本项目 | redis:7-alpine AOF，仅绑 127.0.0.1:**16379** |
| systemd `sg-backend` | 本项目 | uvicorn ×2 workers，仅绑 127.0.0.1:**18300** |
| nginx `conf.d/aivideo.conf` | 本项目 | 80→301→443；443=前端 SPA + /api 反代(含 WS Upgrade) + /uploads 反代，body 300m |

> ⚠️ nginx location 陷阱：`/api/` 与 `/uploads/` 必须用 `^~` 前缀修饰符。
> 否则静态资源正则 location（`\.(js|css|png|...)$`）优先级更高，会把
> `/uploads/xxx.png` 劫持到前端 dist 目录造成 404（后端直连却是 200，
> 2026-11-03 线上已踩过并修复）。

## 关键配置

- 域名：ai-video.zhicekoubei.top → 8.137.18.241（阿里云 DNS）
- 证书：Let's Encrypt HTTP-01（webroot=/opt/supergen-data/webroot），certbot.timer 自动续期（约 2027-02-01 到期前自动续）
- `.env`（/opt/super_gen/backend/.env，600 权限）：
  - `DATABASE_URL=postgresql+asyncpg://scenegen:<密码>@127.0.0.1:15432/scenegen`（密码在 /opt/supergen-data/.secrets）
  - `REDIS_URL=redis://127.0.0.1:16379/0`
  - `CORS_ORIGINS=["https://ai-video.zhicekoubei.top"]`
  - `PUBLIC_BASE_URL=https://ai-video.zhicekoubei.top`（即梦等供应商要公网素材地址）
  - `ADMIN_DEFAULT_EMAIL/PASSWORD`：首启幂等建管理员
  - 阿里云短信（与智策口碑 zckb 共用同一账号/签名/模板，见下节）
- 前端：本地 `npm run build` → tar → 上传 → 原子换 `/opt/super_gen/frontend/dist`

## 短信验证码（阿里云，与智策口碑同一套账号）

注册 / 忘记密码 / 换绑手机号都走阿里云短信验证码，实现见
`backend/app/services/sms_service.py`，配置全部在 `.env`（与智策口碑 zckb 容器环境变量同源）：

| 变量 | 说明 |
|---|---|
| `ALIYUN_ACCESS_KEY_ID` / `ALIYUN_ACCESS_KEY_SECRET` | 与 zckb 共用的 RAM 子账号密钥（只读查询 + SendSms 权限） |
| `ALIYUN_SMS_SIGN_NAME` | 签名「重庆斯迪普瑞文化传播」（已审核通过） |
| `ALIYUN_SMS_TEMPLATE_CODE_REGISTER` | 注册模板 `SMS_506765244`（内容含 `${code}`） |
| `ALIYUN_SMS_TEMPLATE_CODE_RESET` | 找回密码模板 `SMS_506810193`（内容含 `${code}`） |
| `SMS_CODE_EXPIRE_SECONDS` / `SMS_SEND_COOLDOWN_SECONDS` / `SMS_DAILY_LIMIT` | 默认 300s 有效 / 60s 冷却 / 每日 10 条 |

要点：

- 验证码存 Redis（一次性 `GETDEL`、5 次错误作废），发送前必须先过点选人机验证
  （`/auth/captcha/challenge` → `/auth/captcha/verify` → `/auth/sms/send-code`）
- **`.env` 里不要写 `Settings` 未声明的变量**：pydantic `extra="forbid"`，多一个未声明键
  整个后端就起不来（2026-11-18 加 `ALIYUN_SMS_TEMPLATE_CODE_LOGIN` 时踩过，已回退）。
  新增配置项必须先改 `backend/app/core/config.py`
- 只读自检（不花钱、不发短信）：
  ```bash
  cd /opt/super_gen/backend && ./venv/bin/python -c "
  from app.core.config import settings as s
  from alibabacloud_dysmsapi20170525.client import Client
  from alibabacloud_dysmsapi20170525 import models as m
  from alibabacloud_tea_openapi import models as om
  c=Client(om.Config(access_key_id=s.ALIYUN_ACCESS_KEY_ID,access_key_secret=s.ALIYUN_ACCESS_KEY_SECRET,
                     endpoint='dysmsapi.aliyuncs.com',protocol='https'))
  print(c.query_sms_template(m.QuerySmsTemplateRequest(template_code=s.ALIYUN_SMS_TEMPLATE_CODE_REGISTER)).body.to_map())
  print(c.query_sms_sign(m.QuerySmsSignRequest(sign_name=s.ALIYUN_SMS_SIGN_NAME)).body.to_map())"
  ```


## 空库初始化要点（踩坑记录）

本仓库迁移链只含增量表（users 等基础表历史上由 create_all 建立），
**全新空库直接 `alembic upgrade head` 会失败**（organizations 引用不存在的 users）。
正确顺序：

```bash
cd /opt/super_gen/backend
./venv/bin/python -c "import asyncio; from app.core.database import init_db; asyncio.run(init_db())"  # 建全量最新结构
./venv/bin/alembic stamp head      # 标记迁移链到位（create_all 结果 == head 状态）
systemctl restart sg-backend       # 首启自动建 admin + 种子模板库
```

## 日常更新流程

```bash
# 后端
ssh root@8.137.18.241 "cd /opt/super_gen && git pull && cd backend && ./venv/bin/pip install -q -r requirements.txt -i https://mirrors.aliyun.com/pypi/simple/ && systemctl restart sg-backend"
# 前端（本地）
cd frontend && npm run build && tar -czf dist.tar.gz -C dist .
# 上传后：tar -xzf 到 dist.new 再原子 mv（见本地 sg_deploy/sftp_put.py）
```

## 迁移后待补配置（新库从零，旧库数据随旧服务器丢失）

- [ ] 后台「配置模型」重新录入各模型（MiniMax/智谱/即梦等 API Key 全在旧库）
- [ ] 系统设置：SMTP 邮件、支付开关等（KV 存库，同样丢失）
- [ ] 积分计价规则、充值套餐
- [ ] 生产 DEBUG=False 不暴露 /docs；如需排障临时开

## GPT 文生图（OpenAI）出站代理：sg-singbox

大陆机直连 `api.openai.com` 不通，GPT 文生图靠本机 SOCKS5 代理出网（模型 config 里
`"proxy": "socks5h://127.0.0.1:8899"`）。

- 程序：`/root/sing-box/sing-box`，配置 `/root/sing-box/config.json`（socks 入站 127.0.0.1:8899 → trojan 出站）
- **必须用 systemd 常驻**（2026-11-18 之前是手工 `./sing-box run` 跑在 ssh 会话里，会话断开即失联，
  表现为生成报 `All connection attempts failed`）：
  `/etc/systemd/system/sg-singbox.service`，`Restart=always`，已 `enable`
- 排障：`systemctl status sg-singbox` / `journalctl -u sg-singbox -n 50`；
  验证：`curl --socks5-hostname 127.0.0.1:8899 https://api.openai.com/v1/models -H "Authorization: Bearer <key>"`
- 该端口只有本项目使用，未与 zckb / sdpr-crm 共用

## 踩坑：后台「模型标识（model）」必须填接口真实 ID

2026-11-18 线上 GPT 生图全量报
`Adapter error: OpenAI HTTP 400 ... "message": "Invalid model ID."`：
后台 AIModel `GPT Image` 的 `config.model` 被填成了**显示名**「GPT Image」。

- 正确值：`gpt-image-2`（该 Key 可用，支持 2K/3K 任意分辨率；`gpt-image-1` 已不在该 Key 模型列表里）
- 其他可用：`gpt-image-1.5` / `gpt-image-1-mini`（仅 1024/1536 标准尺寸）
- 后台「测试连通」已改为对 OpenAI 真实拉 `/v1/models` 并校验模型 ID 是否存在，
  填错会直接提示「不在该 Key 可用列表中」并列出可用图像模型
- 适配器按模型能力收敛尺寸：只有 `gpt-image-2*` 才发 2K/3K，其余回落标准三档，`dall-e-3` 用 1792 档

