# SceneGen 生产部署指南（单机 · Ubuntu 24.04）

> 本指南在腾讯云 Ubuntu 24.04（2C2G）实例上实测通过。目标拓扑：
>
> ```
> 客户端 ──HTTPS(443)──> nginx
>                        ├── /            → /opt/super_gen/frontend/dist（前端静态 SPA）
>                        ├── /api /health → sg-backend   (uvicorn 127.0.0.1:8000)
>                        ├── /uploads /ws → sg-backend
>                        └── /fs/         → sg-fileserver(uvicorn 127.0.0.1:9001)
> sg-backend ──> PostgreSQL 16 / Redis 7（apt 安装，仅本机监听）
> 公网直链: https://域名/fs/...（备案拦截期用备用端口 :9000 或 :8443）
> ```
>
> 注意 fileserver 内部端口用 **9001**：公网 9000 留给 nginx 备用监听，
> 两者同端口会在重启竞态中互相抢绑定（实测踩坑）。

## 0. 前置条件

| 项 | 要求 |
|----|------|
| 系统 | Ubuntu 22.04/24.04（其他发行版包名自行对应） |
| 配置 | ≥ 2C2G，磁盘 ≥ 20G（含 swap，2G 内存机型建议开启） |
| 域名 | A 记录解析到服务器公网 IP；80/443 可达 |
| Python | 3.11+（Ubuntu 24.04 自带 3.12） |
| 构建 | 前端在本地/CI 构建后上传 `dist/`（服务器无需 Node） |

> **国内云注意（重要）**：腾讯云/阿里云大陆机房要求域名完成 **ICP 备案** 才能正常访问 80/443，
> 未备案域名会被拦截（80 跳转阻断页、443 直接 reset），且 Let's Encrypt HTTP-01 续期也会失败。
> 详见文末「常见问题」。

## 1. 系统依赖与基础设施

```bash
apt-get update
apt-get install -y nginx postgresql postgresql-contrib redis-server python3-venv git curl
```

PostgreSQL / Redis 安装后自动启动，默认仅监听 `127.0.0.1`（保持默认即可，不要开放公网）。

创建数据库（专用角色，不用 postgres 超级用户）：

```bash
DB_PASS=$(openssl rand -hex 16)
sudo -u postgres psql -c "CREATE ROLE scenegen LOGIN PASSWORD '${DB_PASS}';"
sudo -u postgres psql -c "CREATE DATABASE scenegen OWNER scenegen;"
echo "${DB_PASS}"   # 记下来，写进后端 .env
```

## 2. 后端部署（/opt/super_gen）

```bash
git clone https://github.com/xxx-888/super_gen.git /opt/super_gen
cd /opt/super_gen/backend
python3 -m venv venv
# 国内服务器用镜像加速：
./venv/bin/pip install -r requirements.txt -i https://mirrors.cloud.tencent.com/pypi/simple
```

### 2.1 生产 .env

```bash
cp .env.production.example .env
vim .env    # 填 DATABASE_URL / SECRET_KEY(openssl rand -hex 32) / 管理员密码 / 域名
chmod 600 .env
```

关键差异（相对开发环境）：`ENVIRONMENT=production`、`DEBUG=False`（关闭 /docs）、
`CORS_ORIGINS` 收紧到实际域名、数据库/Redis 走 `127.0.0.1`。

### 2.2 初始化数据库（全新空库）

> ⚠️ 本项目迁移链**没有"从零建表"的基线版本**（首个迁移即引用 `users` 表，历史上开发环境一直用
> `create_all` 自动建表）。全新数据库的正确初始化方式：

```bash
cd /opt/super_gen/backend
# 1) create_all 建全量 schema（等价于当前 models 的完整表结构）
./venv/bin/python -c "import asyncio; from app.core.database import init_db; asyncio.run(init_db())"
# 2) 标记迁移基线（此后 alembic 正常增量升级）
./venv/bin/alembic stamp head
```

### 2.3 systemd 常驻

```bash
cp /opt/super_gen/deploy/sg-backend.service.template /etc/systemd/system/sg-backend.service
systemctl daemon-reload
systemctl enable --now sg-backend
curl http://127.0.0.1:8000/health   # {"status":"healthy",...}
```

首次启动会自动创建默认管理员（`ADMIN_DEFAULT_*`，见 `app/services/bootstrap.py`，幂等）。

## 3. 前端部署

前端为纯静态 SPA，axios 走相对路径 `/api/v1`，与后端同域部署即可，**无需**配置 API 地址。

```bash
# 本地（或 CI）构建后上传：
cd frontend && npm ci && npm run build     # 产物 dist/
scp -r dist/* root@服务器:/opt/super_gen/frontend/dist/
```

## 4. 独立文件服务器（可选，推荐）

作用：视频/音频素材转传后拿**公网直链**，供 MiniMax 等生成渠道下载参考素材。
不部署则本地存储 + base64 内嵌（部分渠道不可用）。

```bash
cd /opt/super_gen/fileserver
python3 -m venv venv
./venv/bin/pip install -r requirements.txt -i https://mirrors.cloud.tencent.com/pypi/simple
mkdir -p /data/files
```

systemd 模板见 [`fileserver/fileserver.service`](../fileserver/fileserver.service)，
复制到 `/etc/systemd/system/sg-fileserver.service` 后改环境变量：

- `FILE_SERVER_API_KEY`：`sk-` + `openssl rand -hex 16`，与后端 `.env` 的 `FILE_SERVER_API_KEY` 一致
- `FILE_SERVER_PUBLIC_URL=https://你的域名:9000/fs`（经 nginx `/fs/` 反代暴露）
- `FILE_SERVER_DIR=/data/files`
- `ExecStart` 的 `--host 127.0.0.1 --port 9001`（公网 9000 由 nginx 占用，勿同端口）

```bash
systemctl daemon-reload && systemctl enable --now sg-fileserver
curl http://127.0.0.1:9001/healthz
```

## 5. Nginx + HTTPS

```bash
# 首次申请证书（要求 80 端口公网可达且域名已解析）：
certbot --nginx -d 你的域名

# 站点配置：
cp deploy/nginx-scenegen.conf.template /etc/nginx/sites-available/scenegen
# 替换 __DOMAIN__ 占位符后：
ln -sf /etc/nginx/sites-available/scenegen /etc/nginx/sites-enabled/scenegen
nginx -t && systemctl reload nginx
```

模板包含：SPA 回退、`/api` `/uploads` `/ws`(WebSocket) 反代、`/fs/` 文件服务器反代（前缀剥离）、
gzip、静态资源长缓存、上传体积 500M、长任务读超时 600s。

## 6. 日常运维

```bash
# ---- 更新后端 ----
cd /opt/super_gen && git pull
cd backend && ./venv/bin/pip install -r requirements.txt -i https://mirrors.cloud.tencent.com/pypi/simple
./venv/bin/alembic upgrade head        # 有新迁移时
systemctl restart sg-backend

# ---- 更新前端 ----
本地 npm run build → 上传覆盖 /opt/super_gen/frontend/dist/

# ---- 日志 ----
journalctl -u sg-backend -f            # 后端
journalctl -u sg-fileserver -f         # 文件服务器（含鉴权审计日志）

# ---- 数据库备份（建议 crontab 定时） ----
sudo -u postgres pg_dump scenegen | gzip > /root/backup/scenegen-$(date +%F).sql.gz
```

## 7. 常见问题

### 域名解析正确但外网访问被拦截（302 到阻断页 / 连接 reset）

大陆云机房对**未 ICP 备案**域名拦截 80/443。从服务器自身 `curl --resolve 域名:443:公网IP` 正常、
外网不通即为该问题。解决：

1. 正道：完成域名 ICP 备案（注意 `.cc` 等后缀可能不在可备案列表，需先向云商确认）；
2. 过渡：nginx 监听非常规端口（如 8443，模板中有注释行）+ 云安全组放行，用 `https://域名:8443` 访问；
3. 或换境外服务器（无备案要求）。

### Let's Encrypt 续期失败（HTTP-01 challenge failed）

80 端口被备案拦截会连带导致 HTTP-01 验证失败。改用 **DNS-01**（以 DNSPod 为例）：
在 DNSPod 控制台创建 API 密钥，安装 certbot DNS 插件并切换验证方式；或手动续期
（证书 90 天有效，到期前 `certbot certonly --manual --preferred-challenges dns -d 你的域名`）。

### 文生图报 "All connection attempts failed"（OpenAI 等境外端点）

大陆服务器直连 `api.openai.com` 等境外端点不通（连接被重置）。支持**模型级代理**：
后台「配置模型」→ 对应模型的 config JSON 里加：

```json
{ "model": "gpt-image-1", "proxy": "http://代理IP:端口" }
```

只影响该模型的出站请求（智谱/MiniMax 等国内端点不受影响）。代理出口需在 OpenAI
支持的国家/地区（美国/日本/新加坡等，**香港/澳门不支持**）；也可改用国内可达的
OpenAI 兼容中转 endpoint（把模型 endpoint 换成中转地址，无需代理）。

代理地址支持 `http://`、`socks5://`（含用户名密码）与 `socks5h://`（**推荐**：
域名交给代理解析，规避本地 DNS 污染）：

```json
{ "model": "gpt-image-1", "proxy": "socks5h://用户:密码@代理IP:端口" }
```

依赖 `httpx[socks]`（requirements.txt 已含，旧环境执行
`pip install -r requirements.txt` 补装 socksio）。

### 剧本解析不扣积分

确认计价规则：`credit_pricing` 里存在 `task_type=script_parse` 且**启用**的规则。
注意规则若绑定了具体模型（ai_model_id），只有实际使用该模型解析时才扣费
（未选模型时取后台优先级最高的 LLM 配置）。

### 生成报"未配置模型 / 无渠道"

生产 `.env` 可不填模型 Key：用默认管理员登录后台 →「配置模型」添加渠道
（provider / endpoint / API Key），DB 配置优先于环境变量。

### 文件服务器连通性测试成功，但消息里的直链点开是 404

正常现象：测试流程为 上传探针文件 → 直链下载验证 → **自动删除探针**，
消息里的链接仅供展示，点开时文件已清理。判断链路是否正常以测试结果为准
（或上传一个真实素材看直链能否打开）。

### 上传参考视频/音频后渠道拉取失败

确认 `sg-fileserver` 运行中、后端 `.env` 的 `FILE_SERVER_URL/KEY` 与其一致、
`/fs/healthz` 公网可访问；转传失败会自动降级本地存储（后台任务日志有记录）。

## 8. 安全清单

- [ ] `SECRET_KEY` / 数据库密码 / 管理员密码 均为随机强密码（`openssl rand`）
- [ ] `.env` 权限 600，且**永不提交**（.gitignore 已覆盖）
- [ ] 默认管理员首次登录后立即改密
- [ ] PostgreSQL / Redis / uvicorn / fileserver 仅监听 127.0.0.1，公网只暴露 nginx
- [ ] `DEBUG=False`（/docs 已关闭）
- [ ] 数据库定时备份
- [ ] SSH 改密钥登录、禁 root 密码登录（云安全组只放行必要端口）
