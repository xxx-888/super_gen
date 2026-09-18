# 即梦AI（Jimeng / Seedance）视频生成接入说明

> 对应官方文档《AI 开放平台：视频生成接口文档 v1.1（2026-08-07）》。
> 适配器：`backend/app/adapters/jimeng_adapter.py`，provider 标识 `jimeng`。

## 一、后台配置步骤（模型后台 → 配置模型）

1. 「添加模型」，按下表填写：

| 字段 | 填写值 | 说明 |
|---|---|---|
| 类型 | `image_to_video` | 文生/图生/首尾帧/多模态参考统一走视频类型 |
| 提供方 | `jimeng`（即梦AI Seedance） | |
| 端点 URL | 官方管理后台下发的 **Base URL** | 形如 `https://xxx`；粘完整接口路径也能自动剥离，但建议只填 base |
| API Key | 平台分配的 ApiKey | 注意：若 Key 开了 **IP 白名单**，需把服务器出口 IP 加白 |
| 模型标识 | `fast` / `pro` / `mini` / `seedance2.5` | 即「档位 mode」，四选一；见下方分档矩阵 |

2. （可选）「视频生成超时」块：默认轮询上限 **1800 秒**（含链式超分时整链耗时更长）、间隔 5 秒（官方建议 ≥5s）。
3. 保存后点「测试连接」：用假 task_id 探测——HTTP 401/403 = Key 无效；其余状态（含业务错误）= 鉴权通过。
4. 如需优先使用即梦，把该记录「优先级」调到视频类最高。

## 二、分档参数矩阵（官方 v1.1）

| mode | 分辨率 | 时长(秒) | 参考图 | 参考视频 | 参考音频 |
|---|---|---|---|---|---|
| `pro` | 480p/720p/1080p/**4k** | 4~15 或 -1 | ≤9 | ≤3 | ≤3 |
| `fast`（默认） | 480p/720p/1080p | 4~15 或 -1 | ≤9 | ≤3 | ≤3 |
| `mini` | 480p/720p/1080p | 4~15 或 -1 | ≤9 | ≤3 | ≤3 |
| `seedance2.5` | 480p/720p | **4~30** 或 -1 | **≤30** | **≤10** | **≤10** |

适配器行为：
- **档位取自「模型标识」**，未识别的写法回退 `fast` 并按 fast 上限校验（官方同样规则：只传旧参数不传 mode 按 fast 校验——要用满 2.5 档务必显式选）。
- 素材数量超档位上限 → 自动截断到上限，任务日志记 warning，不拒单。
- 时长超区间 → 自动夹紧到区间端点，日志记 warning；`-1` 为智能时长，原样透传。
- 分辨率：平台写法自动映射（768P→720p、2K→1080p 等）；seedance2.5 收到不支持的分辨率自动降 720p，其余档位直接报错提示可用值。
- `images、videos 都未传时 prompt 必填`（纯音频参考也不例外）——缺 prompt 在提交前拦截。

## 三、Seedance 2.5 专项约束

1. **首帧/首尾帧任务仅支持 `ratio=adaptive`**：官方在创建时同步拒绝。适配器已前置自动纠正（强制 adaptive + 日志警告）。
2. **视频编辑/视频延长任务**（由模型结合提示词意图判定，无法创建时拦截）：官方放行提交后异步失败（`InvalidParameter.TaskTypeConstraint`，不扣费但白排队）。适配器轮询到该错误会给出修复建议文案。**提交这两类任务请自行把 ratio 设为 adaptive**。
3. 视频编辑任务的 `duration` 仅支持 `-1`（输出时长跟随输入视频）。

## 四、素材地址要求

即梦只接受**公网 HttpURL** 或 `asset://<ASSET_ID>`，**不支持 data URI**（与 MiniMax 不同）：

- 平台云存储素材（fileserver 转传后的 https 地址）：直接可用。
- 本地 `/uploads/...` 素材：适配器用 `PUBLIC_BASE_URL` 拼绝对地址。**需在服务端 `.env` 配置**：
  ```
  PUBLIC_BASE_URL=https://ai.sdprcq.cc:8443
  ```
  未配置时本地素材会被跳过并记 warning（不阻断任务）。
- 需要素材加白/版权放行等高级能力时走官方「素材资产管理接口」拿 `asset://id`，平台暂未封装该接口。

## 五、鉴权与错误处理

- Header：`ApiKey: <key>`（不是 Bearer）。
- 响应统一包装：HTTP 200 且 `code==0` 才算成功；`trace_id` 记入任务日志便于官方排障。
- **余额不足**：HTTP 429 + message 含 `40001`，适配器转成明确错误文案（充值后重试）。
- 轮询期查询异常/网关业务错误：按瞬时错误重试（poll_pending），由超时兜底，不误杀任务。
- 任务失败/超时：走平台统一的失败退还积分链路（预扣制，官方"失败不扣费"与平台"失败退积分"口径一致）。

## 六、计费说明

平台为**预扣积分制**（提交前按「积分计价」规则扣，失败/超时退还），官方返回的
`usage.completion_tokens` 仅记入任务 meta 供对账，不做 tokens→积分换算。
如需按即梦成本定价，在后台「计价配置」给对应模型加规则即可。

## 七、能力与入口映射

| 平台能力 | 即梦映射 |
|---|---|
| 文生视频 | 无 images/videos 的 create（prompt 必填） |
| 图生视频（image_url） | 无 @引用素材时 → `role=first_frame`（首帧驱动）；与 @引用同场 → 并入参考图 |
| 首尾帧节点 | `images[].role = first_frame / last_frame` |
| @引用角色/场景/道具图 | `images[].role = reference_image` |
| @引用视频/音频素材 | `videos[] / audios[]`（reference_video / reference_audio） |
| 融合生图（fusion） | 不支持 → 提交时自动降级为 image_to_video（与 MiniMax 同策略） |
| 链式超分 | `extra.super_resolution_config` 透传（目标分辨率须严格高于档位分辨率） |
| 版权放行 | `extra.ips` 透传（≤5 个已备案 kz_ip_id） |
| 取消任务 | 官方不支持，平台取消仅停止本地轮询 |

## 八、高级参数透传（GenInput.extra）

`tools`（web_search 联网）、`super_resolution_config`、`ips`、`bitrate_mode`、
`execution_expires_after`、`seed`、`return_last_frame`、`generate_audio`、`ratio`
—— 由调用方在生成请求 extra 里传入即原样生效，官方网关负责最终校验（错误原文进任务日志）。
