#!/usr/bin/env bash
# =====================================================================
# MiniMax-H3 Ref2VA 服务启动脚本(带崩溃自启看门狗)
# 用法: nohup bash start.sh > watchdog.log 2>&1 &
# 环境变量:
#   H3_API_TOKEN  API Bearer token(默认 h3-sk-9f4c2a7e,务必改成自己的)
#   H3_API_PORT   监听端口(默认 8300)
#   CONDA_ENV     conda 环境名(默认 py312,按实际机器调整)
# 日志: /root/h3api/service.log(可在下方 LOG_DIR 改)
# =====================================================================
export H3_API_TOKEN="${H3_API_TOKEN:-h3-sk-9f4c2a7e}"
export H3_API_PORT="${H3_API_PORT:-8300}"

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="${LOG_DIR:-/root/h3api}"
mkdir -p "$LOG_DIR/outputs" "$LOG_DIR/uploads"

# 激活带 PyTorch 的环境(按需修改;若 python 已在 PATH 可注释掉这段)
if [ -f /usr/local/miniconda3/etc/profile.d/conda.sh ]; then
    source /usr/local/miniconda3/etc/profile.d/conda.sh
    conda activate "${CONDA_ENV:-py312}" 2>/dev/null
    export PATH="/usr/local/miniconda3/envs/${CONDA_ENV:-py312}/bin:$PATH"
fi

# 崩溃自启:服务异常退出后 5 秒拉起
while true; do
    echo "[start.sh $(date +%T)] launching service (port $H3_API_PORT)..."
    python "$BASE_DIR/service.py" >> "$LOG_DIR/service.log" 2>&1
    code=$?
    echo "[start.sh $(date +%T)] service exited (code $code), restart in 5s"
    sleep 5
done
