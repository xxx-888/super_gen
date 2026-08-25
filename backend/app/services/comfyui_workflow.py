"""ComfyUI 工作流处理服务（M8）

- detect_format: 识别 UI 格式（含 nodes/links 数组）与 API 格式（节点 id → {class_type, inputs}）
- parse_workflow: 提取元信息（节点类型统计、模型/采样器名、文本输入、图片输入节点）
- ui_to_api: UI 格式 → /prompt 可执行 API 格式（链接解析为 [源节点, 槽位]；
  常见节点的 widgets_values 按官方控件顺序命名，未覆盖节点尽力映射并记入 warnings）
- apply_placeholders: 替换 {{prompt}}/{{negative}}/{{seed}}/{{width}}/{{height}}/{{model}}
  占位符（后续 comfyui 适配器执行与导出预填共用）
"""
import re
from typing import Any, Dict, List, Optional, Tuple

# 常见节点的控件名（按 ComfyUI 官方节点定义的 widgets 顺序），
# 用于 UI 格式 widgets_values 数组 → API 格式命名 inputs 的映射
_WIDGET_NAMES: Dict[str, List[str]] = {
    "KSampler": ["seed", "control_after_generate", "steps", "cfg", "sampler_name",
                 "scheduler", "denoise"],
    "KSamplerAdvanced": ["add_noise", "noise_seed", "control_after_generate", "steps",
                         "cfg", "sampler_name", "scheduler", "start_at_step", "end_at_step",
                         "return_with_leftover_noise"],
    "CheckpointLoaderSimple": ["ckpt_name"],
    "CheckpointLoader": ["config_name", "ckpt_name"],
    "VAELoader": ["vae_name"],
    "LoraLoader": ["lora_name", "strength_model", "strength_clip"],
    "LoraLoaderModelOnly": ["lora_name", "strength_model"],
    "CLIPTextEncode": ["text"],     # 未连接时 text 是控件值
    "CLIPSetLastLayer": ["stop_at_clip_layer"],
    "EmptyLatentImage": ["width", "height", "batch_size"],
    "SaveImage": ["filename_prefix"],
    "PreviewImage": ["filename_prefix"],
    "LoadImage": ["image", "upload"],
    "LoadImageMask": ["image", "channel"],
    "ImageScale": ["upscale_method", "width", "height", "crop"],
    "LatentUpscale": ["upscale_method", "width", "height", "crop"],
    "VAEDecode": [],
    "VAEEncode": [],
    "ControlNetLoader": ["control_net_name"],
    "ControlNetApplyAdvanced": ["strength", "start_percent", "end_percent"],
    "UNETLoader": ["unet_name"],
    "CLIPVisionLoader": ["clip_name"],
    "StyleModelLoader": ["style_model_name"],
    "UpscaleModelLoader": ["model_name"],
    "ImageUpscaleWithModel": [],
    "SamplerCustom": ["add_noise", "noise_seed", "control_after_generate", "cfg"],
}
# 上表中控件名里含有 control_after_generate（种子后处理选择），API 执行可忽略
_IGNORE_WIDGETS = {"control_after_generate", "upload"}


def detect_format(graph: Any) -> Optional[str]:
    """'ui' / 'api' / None(无法识别)"""
    if not isinstance(graph, dict):
        return None
    if isinstance(graph.get("nodes"), list) and isinstance(graph.get("links"), list):
        return "ui"
    values = list(graph.values())
    if (values and all(isinstance(v, dict) and "class_type" in v for v in values)
            and all(not str(k).startswith(("nodes", "links", "version", "config")) for k in graph)):
        return "api"
    return None


def parse_workflow(graph: Any, fmt: str) -> Dict[str, Any]:
    """提取工作流元信息（不抛错，尽力提取）。"""
    meta: Dict[str, Any] = {"node_types": {}, "models": [], "text_inputs": [],
                            "image_inputs": [], "sampler": None, "output_nodes": []}
    if fmt == "api":
        for nid, node in graph.items():
            ct = node.get("class_type", "?")
            meta["node_types"][ct] = meta["node_types"].get(ct, 0) + 1
            ins = node.get("inputs") or {}
            if ct in ("CheckpointLoaderSimple", "CheckpointLoader", "UNETLoader") and isinstance(ins.get("ckpt_name") or ins.get("unet_name"), str):
                meta["models"].append(ins.get("ckpt_name") or ins.get("unet_name"))
            if ct == "LoraLoader" and isinstance(ins.get("lora_name"), str):
                meta["models"].append(ins["lora_name"])
            if ct == "CLIPTextEncode" and isinstance(ins.get("text"), str):
                meta["text_inputs"].append({"node": str(nid), "title": (node.get("_meta") or {}).get("title", ""), "text": ins["text"][:80]})
            if ct == "LoadImage":
                meta["image_inputs"].append({"node": str(nid), "field": ins.get("image")})
            if ct == "KSampler":
                meta["sampler"] = {k: ins.get(k) for k in ("steps", "cfg", "sampler_name", "scheduler", "denoise") if k in ins}
            if ct in ("SaveImage", "PreviewImage"):
                meta["output_nodes"].append(str(nid))
    else:
        for node in graph.get("nodes", []):
            ct = node.get("type", "?")
            meta["node_types"][ct] = meta["node_types"].get(ct, 0) + 1
            wv = node.get("widgets_values") or []
            if ct == "CheckpointLoaderSimple" and wv:
                meta["models"].append(str(wv[0]))
            if ct == "LoraLoader" and wv:
                meta["models"].append(str(wv[0]))
            if ct == "CLIPTextEncode" and wv:
                meta["text_inputs"].append({"node": str(node.get("id")), "title": node.get("title", ""), "text": str(wv[0])[:80]})
            if ct == "KSampler" and len(wv) >= 6:
                meta["sampler"] = {"steps": wv[1] if len(wv) > 3 else None,
                                   "cfg": wv[2] if len(wv) > 3 else None,
                                   "sampler_name": wv[3] if len(wv) > 3 else None,
                                   "scheduler": wv[4] if len(wv) > 4 else None}
            if ct in ("SaveImage", "PreviewImage"):
                meta["output_nodes"].append(str(node.get("id")))
    meta["models"] = sorted(set(meta["models"]))
    return meta


def ui_to_api(graph: Dict[str, Any]) -> Tuple[Dict[str, Any], List[str]]:
    """UI 格式 → API 执行格式。返回 (api_dict, warnings)。

    链接（links: [id, from_node, from_slot, to_node, to_slot, type]）解析为
    [str(from_node), from_slot]；widgets_values 按控件名映射为命名输入，
    未知节点尽力位置映射，无法映射的记入 warnings（导出仍可用，手动补齐即可）。
    """
    warnings: List[str] = []
    links = {}
    for lk in graph.get("links", []):
        # 兼容 [id, from, fslot, to, tslot, type] 与对象格式
        if isinstance(lk, dict):
            links[lk.get("id")] = (lk.get("origin_id"), lk.get("origin_slot"))
        else:
            links[lk[0]] = (lk[1], lk[2])

    api: Dict[str, Any] = {}
    for node in graph.get("nodes", []):
        nid = str(node.get("id"))
        ct = node.get("type")
        inputs: Dict[str, Any] = {}
        # 1) 连接输入
        for inp in node.get("inputs") or []:
            lk_id = inp.get("link")
            if lk_id is not None and lk_id in links:
                src, slot = links[lk_id]
                inputs[inp.get("name")] = [str(src), int(slot or 0)]
        # 2) 控件值 → 命名输入
        wv = node.get("widgets_values")
        if wv:
            names = _WIDGET_NAMES.get(ct)
            if names is None:
                warnings.append(f"节点 {ct}(#{nid}) 不在内置控件表，控件值按位置写入 inputs.widgets_values")
                inputs["widgets_values"] = wv
            else:
                usable = [n for n in names if n not in _IGNORE_WIDGETS]
                for i, val in enumerate(wv):
                    if i < len(names):
                        if names[i] in _IGNORE_WIDGETS:
                            continue
                        inputs[names[i]] = val
                    else:
                        inputs.setdefault("extra_widget_values", []).append(val)
                if len(wv) > len(names):
                    warnings.append(f"节点 {ct}(#{nid}) 控件数 {len(wv)} 超出已知映射 {len(names)}，多余值在 extra_widget_values")
        api[nid] = {"class_type": ct, "inputs": inputs,
                    "_meta": {"title": node.get("title") or ct}}
    return api, warnings


_PLACEHOLDER_RE = re.compile(r"\{\{\s*(\w+)\s*\}\}")


def apply_placeholders(payload: Any, overrides: Dict[str, Any]) -> Any:
    """递归替换 {{key}} 占位符（overrides 里有的才替换，其余原样保留）。

    整串就是一个占位符且替换值为数字/布尔时保留原类型（seed=42 → int 42，
    而非 "42"——ComfyUI 节点参数对类型敏感）。
    """
    if isinstance(payload, str):
        stripped = payload.strip()
        m = _PLACEHOLDER_RE.fullmatch(stripped)
        if m and m.group(1) in overrides:
            v = overrides[m.group(1)]
            return v if not isinstance(v, str) else payload.replace(stripped, v)
        def _sub(mm):
            key = mm.group(1)
            return str(overrides[key]) if key in overrides else mm.group(0)
        return _PLACEHOLDER_RE.sub(_sub, payload)
    if isinstance(payload, dict):
        return {k: apply_placeholders(v, overrides) for k, v in payload.items()}
    if isinstance(payload, list):
        return [apply_placeholders(v, overrides) for v in payload]
    return payload


def build_export(wf_format: str, graph: Dict[str, Any],
                 overrides: Optional[Dict[str, Any]] = None) -> Tuple[Dict[str, Any], List[str]]:
    """导出为可直接给 ComfyUI 使用的 JSON。

    - format=api: 原样（占位符替换后）
    - format=ui:  转换为 API 执行格式（占位符替换后），warnings 一并返回
    overrides 为空时不做替换，{{prompt}} 等占位符原样保留（用户在 ComfyUI 里改）。
    """
    warnings: List[str] = []
    if wf_format == "api":
        payload = graph
    else:
        payload, warnings = ui_to_api(graph)
    if overrides:
        payload = apply_placeholders(payload, overrides)
    return payload, warnings
