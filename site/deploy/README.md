# 官网部署（app.sdprcq.cc:8888）

服务器：139.155.135.32（腾讯云 · Ubuntu · nginx 1.24）

| 服务器路径 | 仓库文件 | 说明 |
|---|---|---|
| `/opt/sdprcq-site/` | `site/index.html` + `site/assets/` | 静态站点根目录 |
| `/etc/nginx/sites-available/sdprcq-site` → `sites-enabled/` | `nginx-sdprcq-site-ssl.conf` | 8888 站点（**已启用 HTTPS**，2026-09-04 起） |
| `/etc/nginx/sites-available/sdprcq-site.ssl.staged` | `nginx-sdprcq-site-ssl.conf` | 同上（staged 副本，留档） |
| `/etc/nginx/sites-available/sdprcq-80redirect` → `sites-enabled/` | `nginx-sdprcq-80redirect.conf` | 80 端口 ACME 验证 + 301 → https://…:8888 |

## ⚠️ 未备案拦截现状（2026-09-04 实测）

腾讯云边缘对**未备案主机名 `app.sdprcq.cc` 的明文 HTTP（任意端口，按 Host 匹配）**返回 302 到
`https://dnspod.qcloud.com/static/webblock.html?d=app.sdprcq.cc`：

- HTTP:8888 带该 Host → 被拦（国内外源均逐步覆盖）；任意其他 Host / 裸 IP 访问 → 正常
- **TLS 按 SNI 完全放行**（国内外源实测 200）→ 拿到证书切 HTTPS 即恢复访问
- `ai.sdprcq.cc`（平台）暂未被收录拦截
- Let's Encrypt HTTP-01 验证机必然被拦 → **只能用 DNS-01 签发证书**
- 根治：办理 ICP 备案（备案后 HTTP/80 与 HTTP-01 均恢复）

## 证书状态（2026-09-04 已签发）

- Let's Encrypt `app.sdprcq.cc`，DNS-01 手动 TXT 方式签发
- 有效期：2026-09-04 → **2026-12-03**（90 天）
- 路径：`/etc/letsencrypt/live/app.sdprcq.cc/`
- ⚠️ **续期需人工参与**：certbot.timer 自动续期会因无 DNS API 而失败（auth 钩子
  `/root/dns01_auth_hook.sh` 等待标志文件 10 分钟后超时干净退出，不影响现有证书）。
  到期前（约 11 月中下旬）重跑一次手动流程：

```bash
# 手动续期（会打印新 TXT 值，去 DNSPod 更新 _acme-challenge.app 记录后 touch 标志）
rm -f /tmp/certbot_dns_ready
nohup certbot renew --cert-name app.sdprcq.cc --force-renewal \
  > /root/certbot-dns01.log 2>&1 < /dev/null &
cat /root/certbot-dns01.log          # 等出现 TXT_VALUE: xxx
# → DNSPod 更新 TXT → touch /tmp/certbot_dns_ready → systemctl reload nginx
```

升级为全自动（推荐，拿到密钥后执行一次即可）：

```bash
# DNSPod 控制台 → 我的账号 → API 密钥（DP_Id + DP_Key）
apt install -y socat && curl https://get.acme.sh | sh -s email=my@sdprcq.cc
~/.acme.sh/acme.sh --issue --dns dns_dp -d app.sdprcq.cc \
  --dp-key "DP_Id,DP_Key" \
  --install-cert -d app.sdprcq.cc \
  --key-file /etc/letsencrypt/live/app.sdprcq.cc/privkey.pem \
  --fullchain-file /etc/letsencrypt/live/app.sdprcq.cc/fullchain.pem \
  --reloadcmd "systemctl reload nginx"
```

## 启用 HTTPS

```bash
cp /etc/nginx/sites-available/sdprcq-site.ssl.staged /etc/nginx/sites-available/sdprcq-site
# 80 跳转改回 https: sed -i 's|return 301 http://app|return 301 https://app|' /etc/nginx/sites-available/sdprcq-80redirect
nginx -t && systemctl reload nginx
```

后端 CORS（`/opt/super_gen/backend/.env`）已同时放行
`http://app.sdprcq.cc:8888` 与 `https://app.sdprcq.cc:8888`（联系区块拉取 site-config 用）。
