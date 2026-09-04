# 官网部署（app.sdprcq.cc:8888）

服务器：139.155.135.32（腾讯云 · Ubuntu · nginx 1.24）

| 服务器路径 | 仓库文件 | 说明 |
|---|---|---|
| `/opt/sdprcq-site/` | `site/index.html` + `site/assets/` | 静态站点根目录 |
| `/etc/nginx/sites-available/sdprcq-site` → `sites-enabled/` | `nginx-sdprcq-site.conf` | 8888 站点（当前 HTTP） |
| `/etc/nginx/sites-available/sdprcq-site.ssl.staged` | `nginx-sdprcq-site-ssl.conf` | 8888 HTTPS 版（证书就绪后替换启用） |
| `/etc/nginx/sites-available/sdprcq-80redirect` → `sites-enabled/` | `nginx-sdprcq-80redirect.conf` | 80 端口 ACME 验证 + 跳转 |

## ⚠️ 未备案拦截现状（2026-09-04 实测）

腾讯云边缘对**未备案主机名 `app.sdprcq.cc` 的明文 HTTP（任意端口，按 Host 匹配）**返回 302 到
`https://dnspod.qcloud.com/static/webblock.html?d=app.sdprcq.cc`：

- HTTP:8888 带该 Host → 被拦（国内外源均逐步覆盖）；任意其他 Host / 裸 IP 访问 → 正常
- **TLS 按 SNI 完全放行**（国内外源实测 200）→ 拿到证书切 HTTPS 即恢复访问
- `ai.sdprcq.cc`（平台）暂未被收录拦截
- Let's Encrypt HTTP-01 验证机必然被拦 → **只能用 DNS-01 签发证书**
- 根治：办理 ICP 备案（备案后 HTTP/80 与 HTTP-01 均恢复）

## 证书签发（DNS-01，二选一）

```bash
# 方式 A：DNSPod API（自动续期，推荐）
# 密钥：DNSPod 控制台 → 我的账号 → API 密钥（DP_Id + DP_Key）
apt install -y socat && curl https://get.acme.sh | sh -s email=my@sdprcq.cc
~/.acme.sh/acme.sh --issue --dns dns_dp -d app.sdprcq.cc \
  --dp-key "DP_Id,DP_Key" \
  --install-cert -d app.sdprcq.cc \
  --key-file /etc/letsencrypt/live/app.sdprcq.cc/privkey.pem \
  --fullchain-file /etc/letsencrypt/live/app.sdprcq.cc/fullchain.pem \
  --reloadcmd "systemctl reload nginx"
# 密钥写入 ~/.acme.sh/account.conf 后续期全自动

# 方式 B：手动 TXT（一次性，续期需重复）
certbot certonly --manual --preferred-challenges dns -d app.sdprcq.cc
# 按提示在 DNSPod 加 _acme-challenge.app TXT 记录后回车
```

## 启用 HTTPS

```bash
cp /etc/nginx/sites-available/sdprcq-site.ssl.staged /etc/nginx/sites-available/sdprcq-site
# 80 跳转改回 https: sed -i 's|return 301 http://app|return 301 https://app|' /etc/nginx/sites-available/sdprcq-80redirect
nginx -t && systemctl reload nginx
```

后端 CORS（`/opt/super_gen/backend/.env`）已同时放行
`http://app.sdprcq.cc:8888` 与 `https://app.sdprcq.cc:8888`（联系区块拉取 site-config 用）。
