# 独立文件管理服务

给 super_gen 提供公网可访问的文件托管（上传/下载/管理），解决参考视频/音频
需要渠道可下载公网 URL 的问题（MiniMax H3 渠道不收 base64 data URI）。

## 部署（云服务器）

### 方式一：直接运行

```bash
cd fileserver
pip install -r requirements.txt

FILE_SERVER_API_KEY=sk-换成你的密钥 \
FILE_SERVER_PUBLIC_URL=https://files.你的域名.com \
FILE_SERVER_DIR=/data/files \
uvicorn main:app --host 0.0.0.0 --port 9000
```

### 方式二：Docker

```bash
docker build -t sg-fileserver .
docker run -d --name sg-fileserver \
  -p 9000:9000 \
  -v /data/files:/app/data \
  -e FILE_SERVER_API_KEY=sk-换成你的密钥 \
  -e FILE_SERVER_PUBLIC_URL=https://files.你的域名.com \
  sg-fileserver
```

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `FILE_SERVER_API_KEY` | 空 | 上传/列表/删除的鉴权密钥；**留空 = 完全开放（勿用于公网）**。下载直链始终公开（渠道拉取不带鉴权） |
| `FILE_SERVER_PUBLIC_URL` | 空 | 对外公网地址（拼直链用），如 `https://files.abc.com`。本地测试可填 `http://服务器IP:9000` |
| `FILE_SERVER_DIR` | ./data | 存储目录 |
| `FILE_SERVER_MAX_SIZE` | 500MB | 单文件上限 |
| `FILE_SERVER_ALLOWED_EXT` | 空 | 允许的扩展名白名单（逗号分隔），如 `mp4,mov,mp3,wav`；留空不限制 |

建议用 nginx/caddy 反代到域名并配 HTTPS（渠道拉取 http 也可以，但浏览器混合内容限制下 https 更稳）。

## 接口

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/upload` | 是 | multipart 上传，返回 `{url, path, size}`，url 即公网直链 |
| GET | `/files/{path}` | 否 | 公开直链下载（供生成渠道/浏览器访问） |
| GET | `/list?prefix=&offset=&limit=` | 是 | 文件列表（按时间倒序） |
| DELETE | `/files/{path}` | 是 | 删除文件 |
| GET | `/stats` | 是 | 存储统计 |
| GET | `/healthz` | 否 | 健康检查 |

## 与 super_gen 后端集成

在 backend 的 `.env` 配置：

```
FILE_SERVER_URL=https://files.你的域名.com
FILE_SERVER_API_KEY=sk-和上面一致
```

配置后，资源管理上传的**视频/音频**会自动转传到文件服务器，资产直接记录公网 URL
——`@引用` 参考生成时即可作为 `reference_video` / `reference_audio` 真实生效。
未配置时保持原行为（存本地）。上传转传失败自动降级回本地存储，不影响使用。
