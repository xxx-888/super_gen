"""
API Router - V1 API 路由聚合
"""
from fastapi import APIRouter

from app.api.v1 import (
    auth, users, projects, scripts, scenes, resources, tasks, admin,
    organizations, credits, upload, team, materials, episodes, creation,
    workbench, project_members, canvas,
)

api_router = APIRouter()

# 注册各模块路由
api_router.include_router(auth.router, prefix="/auth", tags=["Authentication"])
api_router.include_router(users.router, prefix="/users", tags=["Users"])
api_router.include_router(organizations.router, prefix="/organizations", tags=["Organizations"])
api_router.include_router(team.router, prefix="/organizations/{org_id}", tags=["Team Management"])
api_router.include_router(materials.router, prefix="/organizations/{org_id}/materials", tags=["Material Library"])
api_router.include_router(credits.router, prefix="/credits", tags=["Credits"])
api_router.include_router(upload.router, prefix="/upload", tags=["Upload"])
api_router.include_router(creation.router, prefix="/creation", tags=["AI Creation"])
api_router.include_router(workbench.workbench_router, prefix="/workbench", tags=["Workbench"])
api_router.include_router(workbench.showcase_router, prefix="/showcase", tags=["Showcase"])
api_router.include_router(projects.router, prefix="/projects", tags=["Projects"])
api_router.include_router(episodes.router, prefix="/projects/{project_id}/episodes", tags=["Episodes"])
api_router.include_router(canvas.router, prefix="/projects/{project_id}/canvas", tags=["Canvas"])
api_router.include_router(project_members.router, prefix="/projects/{project_id}/members", tags=["Project Members"])
api_router.include_router(scripts.router, prefix="/scripts", tags=["Scripts"])
api_router.include_router(scenes.router, prefix="/scenes", tags=["Scenes"])
api_router.include_router(resources.router, prefix="/resources", tags=["Resources"])
api_router.include_router(tasks.router, prefix="/tasks", tags=["Tasks"])
api_router.include_router(admin.router, prefix="/admin", tags=["Admin"])
