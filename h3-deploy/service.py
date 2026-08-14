"""MiniMax-H3 Ref2VA API service (single 5090 32G, bnb nf4 quantized).

Endpoints:
  GET  /healthz
  POST /v1/ref2video   (multipart: images[] + prompt + height/width/num_frames/seed)
  GET  /v1/tasks/{id}
  GET  /v1/videos/{file}
Auth: Authorization: Bearer <H3_API_TOKEN>
"""
import os, time, uuid, threading, queue, traceback, gc, subprocess, logging, contextlib
import warnings as _warnings
import torch
import uvicorn
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse
from typing import List, Optional

MODEL_PATH = "/model/ModelScope/MiniMax/MiniMax-H3"
BASE_DIR   = "/root/h3api"
OUT_DIR    = BASE_DIR + "/outputs"
UP_DIR     = BASE_DIR + "/uploads"
API_TOKEN  = os.environ.get("H3_API_TOKEN", "h3-sk-9f4c2a7e")
PORT       = int(os.environ.get("H3_API_PORT", "8300"))
MAX_PIXELS = 960 * 544          # safety cap for 32G VRAM
REF_STEP_S = 12.32              # measured s/step @960x544x124, int4

os.makedirs(OUT_DIR, exist_ok=True)
os.makedirs(UP_DIR, exist_ok=True)
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

# ==================== 日志降噪 ====================
# 屏蔽无害的第三方库噪音(torch Enum 弃用警告 / diffusers experimental 提示 /
# Qwen3VL 处理器 docstring lint 的 [ERROR])和轮询接口的刷屏访问日志。
# 真正的失败仍会以异常 traceback 形式完整打印。
_warnings.filterwarnings("ignore", category=FutureWarning)          # weight_norm 弃用等
_warnings.filterwarnings("ignore", category=DeprecationWarning)
_warnings.filterwarnings("ignore", message=".*is an Enum subclass.*")  # torch _pytree


class _PollAccessFilter(logging.Filter):
    """uvicorn access 日志过滤:成功的 /v1/tasks 与 /healthz 轮询不打印(每 5-10s
    两条,一次生成会刷上百行);POST 提交、下载、非 200 的访问全部保留。"""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except Exception:
            return True
        if " 200 OK" in msg and ("GET /v1/tasks/" in msg or "GET /healthz" in msg):
            return False
        return True


logging.getLogger("uvicorn.access").addFilter(_PollAccessFilter())


def _silence_third_party_logs():
    """在导入 diffusers/transformers 模型类之前调用,屏蔽导入期的提示与 lint。

    - diffusers: 'Modular Diffusers is experimental' / 'Unable to import torchao' (warning 级)
    - transformers: Qwen3VL 处理器的 docstring lint 以 [ERROR] 级刷屏,需压到 CRITICAL 之下
    """
    try:
        from diffusers.utils import logging as _dlog
        _dlog.set_verbosity_error()
    except Exception:
        pass
    try:
        from transformers.utils import logging as _tlog
        _tlog.set_verbosity(41)  # CRITICAL
    except Exception:
        pass


@contextlib.contextmanager
def _fd_filter(fd: int, patterns):
    """fd 级截获 stdout/stderr,丢弃含任一特征串的行,其余原样回放。

    用于两类 logging/warnings 都拦不住的直写:torch C++ 警告(stderr,如
    _pytree 的 Enum 弃用)和 transformers auto_docstring 的 lint print(stdout)。
    只包住短窗口(导入/组件装配),长窗口的实时输出(进度条)会延迟回放。
    """
    import sys
    stream = sys.stdout if fd == 1 else sys.stderr
    stream.flush()
    saved = os.dup(fd)
    r, w = os.pipe()
    os.dup2(w, fd)
    keep = []

    def _pump():
        with os.fdopen(r, "r", errors="replace") as f:
            for line in f:
                if not any(p in line for p in patterns):
                    keep.append(line)

    t = threading.Thread(target=_pump, daemon=True)
    t.start()
    try:
        yield
    finally:
        stream.flush()
        os.close(w)
        os.dup2(saved, fd)
        os.close(saved)
        t.join(timeout=15)
        for line in keep:
            stream.write(line)
        stream.flush()

# ---- compat patch for MiniMax-H3 VAE on torch 2.13+cu132 ----
# The H3 causal-conv VAE feeds CPU/non-contiguous tiles into CUDA conv3d, which falls
# back to aten::slow_conv3d_forward (no CUDA kernel in this build) and crashes.
# Align device/dtype/contiguity of every conv3d input before dispatch.
import torch.nn.functional as _F
_orig_fconv3d = _F.conv3d
def _fconv3d(_input, weight, bias=None, stride=1, padding=0, dilation=1, groups=1):
    if _input.device != weight.device:
        _input = _input.to(weight.device)
    if _input.dtype != weight.dtype:
        _input = _input.to(weight.dtype)
    if not _input.is_contiguous():
        _input = _input.contiguous()
    return _orig_fconv3d(_input, weight, bias, stride, padding, dilation, groups)
_F.conv3d = _fconv3d

app = FastAPI(title="MiniMax-H3 Ref2VA API")
_tasks = {}
_tasks_lock = threading.Lock()
_job_q = queue.Queue()


class Engine:
    """Owns the pipeline; serial execution; swaps heavy components cpu<->cuda per phase."""

    def __init__(self):
        self.ready = False
        self.error = None
        self.busy = False
        self.pipe = None
        self.phase1 = None
        self.phase2 = None

    def load(self):
        _silence_third_party_logs()
        # torchao/_pytree 的 C++ 弃用警告在 diffusers 和 transformers 的导入链都会触发
        # (直写 stderr),统一用 fd 过滤包住;加载进度条在 from_pretrained 里,不受影响
        with _fd_filter(2, ("is an Enum subclass",)):
            from diffusers import ModularPipeline, BitsAndBytesConfig, MiniMaxH3Transformer3DModel
            from transformers import Qwen3VLForConditionalGeneration, BitsAndBytesConfig as BnBConfig
        q_tr = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_compute_dtype=torch.bfloat16,
                                  bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True)
        q_te = BnBConfig(load_in_4bit=True, bnb_4bit_compute_dtype=torch.bfloat16,
                         bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True)
        pipe = ModularPipeline.from_pretrained(MODEL_PATH, workflow="ref2va")
        # Every H3 block builds its small tensors (latents_mean/std, pixel_mean/std, ...)
        # on the pipeline's execution device, which without a ComponentsManager defaults
        # to CPU. Pin it to CUDA: this is the single-device semantics the manager provides.
        type(pipe)._execution_device = property(lambda self: torch.device("cuda"))
        # transformers auto_docstring 的 lint 是裸 print(直写 stdout),fd 级截掉;
        # 组件加载的进度条走 stderr,不受影响
        with _fd_filter(1, ("[ERROR]", "not documented")):
            pipe.load_components(dtype=torch.bfloat16, pretrained_model_name_or_path=MODEL_PATH)
        pipe.vae.to("cpu")
        pipe.audio_vae.to("cpu")
        pipe.text_encoder = Qwen3VLForConditionalGeneration.from_pretrained(
            MODEL_PATH, subfolder="text_encoder", dtype=torch.bfloat16,
            quantization_config=q_te, low_cpu_mem_usage=True)
        pipe.text_encoder.to("cpu")
        gc.collect(); torch.cuda.empty_cache()
        pipe.transformer_ref = MiniMaxH3Transformer3DModel.from_pretrained(
            MODEL_PATH, subfolder="transformer_ref", dtype=torch.bfloat16,
            quantization_config=q_tr, low_cpu_mem_usage=True)
        pipe.transformer_ref.to("cpu")
        gc.collect(); torch.cuda.empty_cache()
        sub = pipe.blocks.sub_blocks
        names = list(sub.keys())
        idx = names.index("denoise.denoise")
        self.phase1 = names[:idx]
        self.phase2 = names[idx:]
        # The H3 pipeline was built to run under a ComponentsManager that keeps every tensor
        # on one device. We drive the blocks manually and swap models on/off the GPU, so guard
        # the DiT: force every tensor it receives onto the model's device.
        def _align(mod, args, kwargs):
            try:
                dev = next(mod.parameters()).device
            except StopIteration:
                dev = torch.device("cuda")
            ag = tuple(a.to(dev) if isinstance(a, torch.Tensor) and a.device != dev else a for a in args)
            kw = {k: (v.to(dev) if isinstance(v, torch.Tensor) and v.device != dev else v)
                  for k, v in kwargs.items()}
            return ag, kw
        pipe.transformer_ref.register_forward_pre_hook(_align, with_kwargs=True)
        self.pipe = pipe
        self.ready = True


engine = Engine()


def _worker():
    while True:
        tid = _job_q.get()
        try:
            _run_task(tid)
        except Exception as e:
            tb = traceback.format_exc()
            print(f"[task {tid} FAILED] {type(e).__name__}: {e}", flush=True)
            print(tb[-1500:], flush=True)
            with _tasks_lock:
                t = _tasks.get(tid)
                if t:
                    t.update(status="failed",
                             error=type(e).__name__ + ": " + str(e),
                             trace=tb[-2000:])
        finally:
            engine.busy = False
            _job_q.task_done()


def _set(tid, **kw):
    with _tasks_lock:
        if tid in _tasks:
            _tasks[tid].update(kw)


def _vm(tag):
    try:
        print("  [vm " + tag + "] VRAM=" + subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            capture_output=True, text=True).stdout.strip() + "MiB", flush=True)
    except Exception:
        pass


def _cuda(model):
    """Move a (possibly bnb-quantized) model to cuda, then fix up buffers that bnb's
    patched .to() leaves behind (e.g. the RoPE inv_freq buffer)."""
    model.to("cuda")
    for b in model.buffers():
        if b.device.type != "cuda":
            b.data = b.data.to("cuda")
    return model


def _check_cancel(tid, pipe) -> bool:
    """任务取消检查:置位则释放显存并标记 cancelled,返回 True 由调用方退出。

    去噪循环内部无法打断(CUDA kernel 不可中断),只能在阶段边界生效:
    排队中/编码阶段取消立即生效;去噪中取消会在去噪完成后丢弃结果。"""
    with _tasks_lock:
        t = _tasks.get(tid) or {}
    if t.get("status") != "cancelled" and not t.get("cancel_requested"):
        return False
    for name in ("transformer_ref", "text_encoder", "vae", "audio_vae"):
        try:
            getattr(pipe, name).to("cpu")
        except Exception:
            pass
    gc.collect(); torch.cuda.empty_cache()
    _set(tid, status="cancelled", finished=time.time())
    print(f"  [task {tid}] cancelled, GPU released", flush=True)
    return True


def _run_task(tid):
    from diffusers.modular_pipelines.minimax_h3 import MiniMaxH3ImageReference
    from diffusers.modular_pipelines.modular_pipeline import PipelineState
    from diffusers.utils.export_utils import encode_video
    with _tasks_lock:
        t = dict(_tasks[tid])
        if t.get("status") == "cancelled":  # 排队期间被取消,直接跳过
            print(f"  [task {tid}] cancelled while queued, skip", flush=True)
            return
    pipe = engine.pipe
    t0 = time.time()
    steps = int(t.get("steps") or 49)
    # ---- reset device state: the previous task may have left vae/audio_vae on cuda ----
    pipe.vae.to("cpu")
    pipe.audio_vae.to("cpu")
    gc.collect(); torch.cuda.empty_cache()
    # ---- adaptive reference resolution: default short-edge 2048 is the 4-GPU release
    # geometry; on 32G a single 2-image request OOMs the text encoder's vision tower.
    # 分档:1-2 张 1536(参考保真优先),3-4 张 1280,5-6 张 1024,更多 896;
    # H3_REF_SHORT_EDGE 可作为全局上限压低。
    n_refs = len(t["images"])
    edge = 1536 if n_refs <= 2 else (1280 if n_refs <= 4 else (1024 if n_refs <= 6 else 896))
    edge = min(edge, int(os.environ.get("H3_REF_SHORT_EDGE", "2048")))
    pipe.config.reference_image_short_edge = edge
    _set(tid, status="encoding", started=time.time())
    refs = [MiniMaxH3ImageReference.from_file(p) for p in t["images"]]
    # condition latents live on CPU, video/audio noise on CUDA: one device-typed generator
    # can't serve both, so seed the global RNG and let each randn draw use its own device.
    seed = t["seed"] if t["seed"] is not None else int(time.time())
    torch.manual_seed(seed)
    state = PipelineState()
    provided = {"prompt": t["prompt"], "references": refs, "height": t["height"],
                "width": t["width"], "num_frames": t["num_frames"], "generator": None,
                "num_inference_steps": int(t.get("steps") or 49),
                "output_type": "pil", "latents": None, "audio_latents": None}
    for inp in pipe.blocks.inputs:
        name = getattr(inp, "name", None)
        default = getattr(inp, "default", None)
        kt = getattr(inp, "kwargs_type", None)
        if name in provided:
            state.set(name, provided[name], kt)
        elif name is not None and name not in state.values:
            state.set(name, default, kt)
    # ---- phase 1: text encoding (text_encoder on cuda) ----
    # Hide transformer_ref during phase 1: with a CPU transformer attached, the layout
    # blocks place position_ids and friends on CPU, and the CUDA denoise crashes on the
    # mixed devices. With it absent the tensors default to CUDA, as in the reference run.
    tr = pipe.transformer_ref
    pipe.transformer_ref = None
    pipe.text_encoder.to("cuda"); _cuda(pipe.text_encoder); _vm("te->cuda")
    with torch.inference_mode():
        for n in engine.phase1:
            if n == "vae_encoder":
                pipe.text_encoder.to("cpu")
                gc.collect(); torch.cuda.empty_cache(); _vm("te->cpu")
                pipe.vae.to("cuda")
                pipe.audio_vae.to("cuda")
            pipe.blocks.sub_blocks[n](pipe, state)
    pipe.transformer_ref = tr
    if _check_cancel(tid, pipe):  # 编码阶段取消:GPU 已释放,直接放弃
        return
    # H3 blocks leave state tensors on CPU (encode_vae_condition returns CPU tensors);
    # the pipeline assumes a manager pins everything to one device. Align every tensor in
    # state to CUDA so the DiT forward and the scheduler step agree on device.
    for _k, _v in list(state.values.items()):
        if isinstance(_v, torch.Tensor) and _v.device.type != "cuda":
            state.values[_k] = _v.to("cuda")
    _set(tid, status="denoising", denoise_start=time.time(),
         est_steps=steps,
         est_step_s=max(4.0, REF_STEP_S * (t["width"] * t["height"]) / MAX_PIXELS * (t["num_frames"] / 124)))
    # ---- phase 2: denoise + decode (transformer_ref on cuda) ----
    pipe.vae.to("cpu")
    pipe.audio_vae.to("cpu")
    gc.collect(); torch.cuda.empty_cache(); _vm("vae->cpu-pre-tr")
    _cuda(pipe.transformer_ref); _vm("tr->cuda")
    with torch.inference_mode():
        for n in engine.phase2:
            if n == "decode.video":
                pipe.transformer_ref.to("cpu")
                gc.collect(); torch.cuda.empty_cache()
                pipe.vae.to("cuda")
                _set(tid, status="decoding")
            if n == "decode.audio":
                pipe.audio_vae.to("cuda")
            pipe.blocks.sub_blocks[n](pipe, state)
    vids = state.get("videos")
    aud = state.get("audio")
    sr = state.get("sampling_rate")
    if _check_cancel(tid, pipe):  # 去噪中取消:跑完但丢弃结果
        return
    outp = OUT_DIR + "/" + tid + ".mp4"
    encode_video(vids[0], fps=24, output_path=outp, audio=aud[0], audio_sample_rate=sr)
    ups = (t.get("upscale") or "").strip().lower()
    if ups in ("720p", "720"):
        if _upscale_video(outp, 720):
            print(f"  [upscale] {tid} -> 720p", flush=True)
    elif ups in ("1080p", "1080"):
        if _upscale_video(outp, 1080):
            print(f"  [upscale] {tid} -> 1080p", flush=True)
    _set(tid, status="completed", finished=time.time(),
         elapsed=round(time.time() - t0, 1), video=tid + ".mp4", size=os.path.getsize(outp))


def _upscale_video(path: str, target_h: int) -> bool:
    """用 ffmpeg lanczos 把成品视频上采样到目标高度(720/1080),原地替换。

    这是插值放大:得到交付分辨率,不增加真实细节。失败返回 False(保留原片)。
    """
    try:
        from imageio_ffmpeg import get_ffmpeg_exe
        tmp = path + f".up{target_h}.mp4"
        cmd = [get_ffmpeg_exe(), "-y", "-i", path,
               "-vf", f"scale=-2:{target_h}:flags=lanczos",
               "-c:v", "libx264", "-preset", "fast", "-crf", "18",
               "-c:a", "copy", tmp]
        r = subprocess.run(cmd, capture_output=True, timeout=900)
        if r.returncode == 0 and os.path.getsize(tmp) > 0:
            os.replace(tmp, path)
            return True
        return False
    except Exception:
        return False


def _auth(authorization):
    if not authorization or authorization != "Bearer " + API_TOKEN:
        raise HTTPException(401, "invalid token")


@app.get("/healthz")
def healthz():
    return {"ready": engine.ready, "error": engine.error, "busy": engine.busy,
            "queued": _job_q.qsize(), "total_tasks": len(_tasks),
            "vram": subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader"],
                                   capture_output=True, text=True).stdout.strip()}


@app.post("/v1/ref2video")
async def ref2video(images: List[UploadFile] = File(...), prompt: str = Form(...),
                    height: int = Form(544), width: int = Form(960),
                    num_frames: int = Form(124), seed: Optional[int] = Form(None),
                    steps: int = Form(49), upscale: Optional[str] = Form(None),
                    authorization: Optional[str] = Header(None)):
    _auth(authorization)
    if not engine.ready:
        raise HTTPException(503, "model still loading")
    if not (1 <= len(images) <= 9):
        raise HTTPException(400, "1-9 images required")
    if height % 32 or width % 32:
        raise HTTPException(400, "height/width must be multiples of 32")
    if width * height > MAX_PIXELS:
        raise HTTPException(400, "max " + str(MAX_PIXELS) + " px (e.g. 960x544) on 32G VRAM")
    if not (100 <= num_frames <= 380):
        raise HTTPException(400, "num_frames 100-380 (5-15s @24fps)")
    # H3 的视频 VAE 只能编码 17n+5 帧,且总帧数上限 360 → 有效档位 124(≈5s)..345(≈14.4s)。
    # 对用户传入的任意帧数取最近合法档,避免 15s(360帧,向上取整 362)这类越界。
    n = max(7, min(20, round((num_frames - 5) / 17)))
    num_frames = 17 * n + 5
    steps = max(10, min(49, int(steps)))
    ups = (upscale or "").strip().lower()
    if ups not in ("", "720p", "720", "1080p", "1080"):
        raise HTTPException(400, "upscale must be 720p / 1080p / empty")
    tid = uuid.uuid4().hex[:16]
    updir = UP_DIR + "/" + tid
    os.makedirs(updir)
    paths = []
    for i, f in enumerate(images):
        p = updir + "/" + ("%02d_" % i) + (f.filename or "img")
        with open(p, "wb") as fh:
            fh.write(await f.read())
        paths.append(p)
    # 清洗前端富文本编辑器混入的零宽字符(U+200B/U+200C/U+FEFF),污染 prompt 会干扰生成
    clean_prompt = prompt.replace("\u200b", "").replace("\u200c", "").replace("\ufeff", "")
    with _tasks_lock:
        _tasks[tid] = {"id": tid, "status": "queued", "created": time.time(), "prompt": clean_prompt,
                       "images": paths, "height": height, "width": width,
                       "num_frames": num_frames, "seed": seed, "n_images": len(paths),
                       "steps": steps, "upscale": ups}
    engine.busy = True
    _job_q.put(tid)
    return {"task_id": tid, "status": "queued", "poll": "/v1/tasks/" + tid}


@app.post("/v1/tasks/{tid}/cancel")
def cancel_task(tid: str, authorization: Optional[str] = Header(None)):
    """取消任务。

    - 排队中:立即取消,不占 GPU
    - 编码/准备阶段:阶段边界生效(秒级),释放 GPU
    - 去噪中:CUDA kernel 不可中断,需等去噪跑完后丢弃结果
    """
    _auth(authorization)
    with _tasks_lock:
        t = _tasks.get(tid)
    if not t:
        raise HTTPException(404, "no such task")
    st = t.get("status")
    if st in ("completed", "failed", "cancelled"):
        return {"task_id": tid, "status": st, "message": "already finished"}
    if st == "queued":
        _set(tid, status="cancelled", finished=time.time())
        return {"task_id": tid, "status": "cancelled", "stage": "queued"}
    _set(tid, cancel_requested=True)
    return {"task_id": tid, "status": "cancelling", "stage": st,
            "message": "将在当前阶段边界取消并释放 GPU"}


@app.get("/v1/tasks/{tid}")
def task(tid: str, authorization: Optional[str] = Header(None)):
    _auth(authorization)
    with _tasks_lock:
        t = _tasks.get(tid)
    if not t:
        raise HTTPException(404, "no such task")
    r = {k: v for k, v in t.items() if k != "images"}
    if t["status"] == "denoising":
        el = time.time() - t["denoise_start"]
        tot = t.get("est_steps", 49) * t.get("est_step_s", 12.3)
        r["progress"] = round(min(0.97, el / tot), 3)
        r["elapsed_s"] = round(el, 1)
        r["eta_s"] = round(max(0, tot - el), 1)
    if t["status"] == "completed":
        r["video_url"] = "/v1/videos/" + t["video"]
    return r


@app.get("/v1/videos/{fn}")
def video(fn: str, authorization: Optional[str] = Header(None)):
    _auth(authorization)
    if "/" in fn or ".." in fn:
        raise HTTPException(400, "bad filename")
    p = OUT_DIR + "/" + fn
    if not os.path.isfile(p):
        raise HTTPException(404, "not found")
    return FileResponse(p, media_type="video/mp4", filename=fn)


def _load_model_thread():
    try:
        engine.load()
    except Exception as e:
        engine.error = type(e).__name__ + ": " + str(e)
        traceback.print_exc()


if __name__ == "__main__":
    threading.Thread(target=_load_model_thread, daemon=True).start()
    threading.Thread(target=_worker, daemon=True).start()
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
