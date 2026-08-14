# MiniMax-H3 Ref2VA 自部署服务 — 换机部署方案

单张消费级显卡(24–32G)跑 MiniMax-H3 多图参考生视频(Ref2VA)并对外提供 HTTP API。
本方案在 **RTX 5090 32G / 64G 内存 / torch 2.13+cu132** 实测跑通:一条 5 秒 960×544 带音频视频约 **12 分钟**,显存峰值 **23.8G**。

```
super_gen 后端 ──HTTP──> h3-deploy/service.py(FastAPI, 本目录)
                              │  bnb nf4 4-bit 量化 + 分阶段换入/换出显存
                              ▼
                    /model/ModelScope/MiniMax/MiniMax-H3(465G 全量权重)
```

## 目录内容

| 文件 | 说明 |
|---|---|
| `service.py` | 全部服务端代码(FastAPI + 推理编排 + 5 项兼容补丁,有注释) |
| `install.sh` | 一键装依赖 + 关键导入/内核冒烟测试 |
| `start.sh` | 看门狗启动(崩溃 5 秒自启),读 `H3_API_TOKEN`/`H3_API_PORT` |
| `deploy.md` | 本文档 |

## 1. 硬件 / 软件要求

| 项 | 最低 | 实测基准 |
|---|---|---|
| GPU 显存 | 24G | 5090 32G(Blackwell sm_120) |
| 系统内存 | 48G | 64G(两个 33B 模型 4-bit 常驻 ~34G) |
| 磁盘 | 模型 465G + 50G 系统盘 | 模型放数据盘/共享存储 |
| CUDA/驱动 | CUDA ≥ 12.8(Blackwell 必须) | CUDA 13.2 / driver 595.80 |
| Python 环境 | 3.12 + PyTorch ≥ 2.5(带 CUDA) | torch 2.13.0+cu132, conda env `py312` |

> 显存 24G 也可跑:把 `service.py` 里分辨率上限 `MAX_PIXELS` 降到 512×288 左右。
> 内存 48G 以下跑不动(两个 4-bit 模型 + VAE 常驻)。

## 2. 模型准备

ModelScope 下载全量(已有可跳过):

```bash
# 任选目录,记住路径(下文以 /model/ModelScope/MiniMax/MiniMax-H3 为准)
pip install modelscope
modelscope download --model MiniMax/MiniMax-H3 --local_dir /model/ModelScope/MiniMax/MiniMax-H3
```

实际只用到这些子目录(想省空间可只下这些):`transformer_ref/ text_encoder/ vae/ audio_vae/
tokenizer/ processor/ scheduler/ audio_scheduler/ modular_model_index.json`

## 3. 安装(在 GPU 服务器上)

```bash
# 进到带 PyTorch+CUDA 的环境(按机器实际情况)
conda activate py312        # 或你自己的环境名

# 上传本目录 3 个文件到服务器(示例用 scp)
scp -P <ssh端口> service.py install.sh start.sh root@<服务器>:/root/h3-deploy/

cd /root/h3-deploy
bash install.sh             # 最后必须看到 INSTALL OK
```

要点(踩过的坑,已在 install.sh 里处理):
- **diffusers 必须装 main 分支**(发布版没有 H3 集成):`pip install https://github.com/huggingface/diffusers/archive/refs/heads/main.zip`
- **量化用 bitsandbytes nf4**。不要用 torchao int4:其 int4 内核依赖 `mslk`(装自
  `pip install mslk --index-url https://download.pytorch.org/whl/cu130`),在 cu132/driver595
  上 `cutlass cannot initialize`,不可用。
- 服务器没有 git 时,diffusers 用上面的 zip 直装。

## 4. 启动与验证

```bash
cd /root/h3-deploy
H3_API_TOKEN=改成你自己的token nohup bash start.sh > watchdog.log 2>&1 &

# 模型加载 4-5 分钟,轮询直到 ready:true
watch -n 10 'curl -s http://localhost:8300/healthz'

# 跑通冒烟(单图参考 → 5 秒视频,约 12 分钟)
curl -X POST http://localhost:8300/v1/ref2video \
  -H "Authorization: Bearer 改成你自己的token" \
  -F "images=@test.jpg" \
  -F "prompt=The person from <Picture 1> walks on the moon, cinematic" \
  -F "height=544" -F "width=960" -F "num_frames=124"
# → {"task_id":"..."} ; GET /v1/tasks/{task_id} 看 progress;完成后 GET /v1/videos/{task_id}.mp4
```

对外暴露:云平台控制台给容器加端口映射(如 `8300`),或临时 `ssh -L 8300:localhost:8300`。

## 5. API 一览(均需 `Authorization: Bearer <token>`)

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 无需鉴权。`{ready,busy,queued,vram}` |
| POST | `/v1/ref2video` | multipart 提交,见下 |
| GET | `/v1/tasks/{id}` | 状态 `queued/encoding/denoising/decoding/completed/failed`;denoising 带 `progress/eta_s` |
| GET | `/v1/videos/{file}` | 下载 mp4 |

`/v1/ref2video` 字段:
- `images`:1–9 张参考图(文件数组);prompt 里用 `<Picture 1>`、`<Picture 2>`… 按顺序引用
- `prompt`:文本
- `height`/`width`:32 的倍数,`width*height ≤ 960×544`(32G 显存保护,在 `service.py` 的 `MAX_PIXELS` 调)
- `num_frames`:121–365(24fps,5–15 秒;内部自动对齐 17n+5)
- `seed`:可选

**限制**:单卡串行,一次只能跑一条任务(排队)。

## 6. 性能基线(5090 32G 实测)

| 阶段 | 耗时 |
|---|---|
| 服务启动加载(一次性) | 4–5 min |
| 文本编码(Qwen3VL 4-bit) | ~10 s |
| 去噪 49 步 × 12.3 s | ~10 min |
| VAE 解码 | ~10 s |
| **单条 960×544×5s 总计** | **~700 s** |
| 显存峰值(denoise 时) | 23.8 G |
| 空闲显存 / 常驻内存 | 0.6 G / ~35 G |

## 7. 服务端实现要点(为什么 service.py 长这样)

全量 bf16 要 4 卡(~160G)。单卡方案:**transformer_ref 与 text_encoder(各 33B)都量化到
bnb nf4(各 ~17G,覆盖率 98.4%),常驻内存、按阶段换入显存;VAE 只在编解码时上卡**。

由于绕开官方 ComponentsManager(它与 bnb 量化模型组合会死锁),`service.py` 手动按
pipeline block 分阶段执行,并内置 5 项兼容补丁(都有注释,升级 diffusers 后若官方修复可逐项移除):

1. `F.conv3d` 设备/dtype/连续性对齐 — H3 VAE 因果卷积会把 CPU 切片喂进 CUDA 卷积,
   部分 torch 构建无 `slow_conv3d` 的 CUDA 内核,直接崩。
2. 全局 `torch.manual_seed` + `generator=None` — 条件噪声在 CPU、视频噪声在 CUDA,
   单一设备的 generator 无法同时服务两者。
3. phase1 期间摘下 `transformer_ref` — 否则布局块把 `position_ids` 等放到 CPU,
   CUDA 去噪时设备错位。
4. bnb 模型 `.to(cuda)` 后补搬 buffer — bnb 改写的 `.to()` 会漏掉 RoPE `inv_freq` 等
   非量化 buffer。
5. 管线 `_execution_device` 属性钉死 CUDA + DiT 输入 pre-hook — 各 block 内部小张量
   (latents_mean/std 等)默认按该属性建,无管理器时是 CPU。

## 8. 换服务器 Checklist

1. 核对硬件(显存≥24G、内存≥48G)、CUDA/驱动、模型目录路径(不是默认路径就改
   `service.py` 顶部 `MODEL_PATH`)。
2. 上传 3 个文件 → `bash install.sh`(必须 INSTALL OK)。
3. `H3_API_TOKEN=xxx nohup bash start.sh > watchdog.log 2>&1 &`。
4. 等 `healthz` ready → 跑一条冒烟视频。
5. 平台控制台映射 8300 端口;把 endpoint/token 配回 super_gen 后台的模型配置。
6. (可选)按新卡显存调 `MAX_PIXELS`;监控 `service.log` 与 `nvidia-smi`。

## 9. 故障排查

| 现象 | 处理 |
|---|---|
| healthz 一直 `ready:false` | 看 `service.log`;多为模型路径错 / diffusers 版本不含 H3 |
| 提交返回 400 max pixels | 分辨率超 `MAX_PIXELS`,调小或改上限 |
| `slow_conv3d` / 设备不匹配报错 | 确认用的是本目录 `service.py`(补丁都在里面) |
| 任务 failed:OutOfMemory | 降分辨率/帧数;确认无其他进程占显存(`nvidia-smi`) |
| 服务挂了自动重启但反复崩 | `watchdog.log` + `service.log` 定位;常见是内存不足(OOM killer) |
| 想看实时进度 | `tail -f service.log`(有 `[vm]` 显存轨迹与阶段日志) |
