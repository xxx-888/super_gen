"""
AI Model Adapters - AI 模型适配器框架 (M5)

统一接口, 屏蔽不同模型厂商(星融/Kling/Runway/ComfyUI/本地SD等)的差异.
按 AIModel.provider/type 由 factory 动态选择具体适配器.

包结构:
- base.py        抽象基类 + GenResult 数据类
- factory.py     工厂: AIModel -> Adapter
- placeholder.py 占位适配器(返回 placeholder URL, 供联调; 后续接真实 API)
- cloud_api.py   云API适配器骨架(httpx, 待填具体厂商)
- comfyui.py     ComfyUI 适配器骨架(复用 ComfyUIWorkflow 模型)
"""
