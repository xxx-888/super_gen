#!/usr/bin/env bash
# =====================================================================
# MiniMax-H3 Ref2VA 自部署服务 - 一键安装依赖(在 GPU 服务器上执行)
# 前置要求见 deploy.md(硬件/驱动/模型目录)
# 用法: bash install.sh
# =====================================================================
set -o pipefail

MODEL_DIR="${MODEL_DIR:-/model/ModelScope/MiniMax/MiniMax-H3}"

echo "== [0/5] 环境检查 =="
nvidia-smi >/dev/null 2>&1 || { echo "错误: nvidia-smi 不可用"; exit 1; }
[ -d "$MODEL_DIR" ] || { echo "错误: 模型目录不存在: $MODEL_DIR (用 MODEL_DIR=... 覆盖)"; exit 1; }
python -c "import torch" 2>/dev/null || { echo "错误: 当前 python 环境没有 torch(请在带 PyTorch 的 conda 环境里运行)"; exit 1; }
python - <<'PY'
import torch
print("torch", torch.__version__, "| cuda avail:", torch.cuda.is_available(),
      "| cap:", torch.cuda.get_device_capability())
PY

echo "== [1/5] 升级 pip 基础件 =="
python -m pip install -U pip setuptools wheel

echo "== [2/5] 安装 diffusers(main 分支,含 H3 ModularPipeline) =="
# 必须用 main:发布版尚无 MiniMax-H3 集成
python -m pip install "https://github.com/huggingface/diffusers/archive/refs/heads/main.zip"

echo "== [3/5] 安装 transformers / accelerate / 量化 / 媒体 =="
python -m pip install -U transformers accelerate safetensors sentencepiece protobuf einops
python -m pip install -U bitsandbytes          # nf4 4-bit 量化(核心)
python -m pip install av imageio imageio-ffmpeg

echo "== [4/5] 安装 Web 服务 =="
python -m pip install fastapi "uvicorn[standard]" python-multipart

echo "== [5/5] 验证关键导入 =="
python - <<'PY'
ok = True
try:
    import diffusers, transformers, bitsandbytes, fastapi
    from diffusers import ModularPipeline, BitsAndBytesConfig, MiniMaxH3Transformer3DModel
    from transformers import Qwen3VLForConditionalGeneration, BitsAndBytesConfig as B
    print("diffusers", diffusers.__version__, "| transformers", transformers.__version__,
          "| bitsandbytes", bitsandbytes.__version__)
except Exception as e:
    ok = False
    print("导入失败:", e)
# 4-bit 卷积/线性 kernel 在本机 GPU 上的可用性冒烟测试
try:
    import torch
    from bitsandbytes.nn import Linear4bit
    layer = Linear4bit(5376, 14336, bias=True, compute_dtype=torch.bfloat16,
                       quant_type="nf4").cuda()
    y = layer(torch.randn(1, 1024, 5376, device="cuda", dtype=torch.bfloat16))
    print("nf4 forward OK:", tuple(y.shape), "nan:", torch.isnan(y).any().item())
except Exception as e:
    ok = False
    print("nf4 冒烟测试失败:", repr(e)[:200])
print("INSTALL", "OK" if ok else "FAILED")
PY
