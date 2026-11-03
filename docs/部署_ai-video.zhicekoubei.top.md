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
- 前端：本地 `npm run build` → tar → 上传 → 原子换 `/opt/super_gen/frontend/dist`

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
