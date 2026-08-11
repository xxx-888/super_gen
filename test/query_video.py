"""
手动测试自部署 MiniMax-H3 视频生成服务的查询接口。

用法（在 backend 目录下用 venv 运行）：
    # 查询单个任务状态
    ../venv/Scripts/python.exe ../test/query_video.py video_1d5229ceeac046789038f742cbb1837b

    # 不传 job_id 则列出最近任务
    ../venv/Scripts/python.exe ../test/query_video.py

    # 轮询某个任务直到完成
    ../venv/Scripts/python.exe ../test/query_video.py --poll video_xxx

    # 下载某个已完成任务的视频到本地
    ../venv/Scripts/python.exe ../test/query_video.py --download video_xxx

也可以直接用系统 python（无依赖）：
    python test/query_video.py video_xxx
"""
import sys
import json
import time
import argparse
import urllib.request
import urllib.error

# ===== 配置（按需修改）=====
_CONFIG = {
    "base_url": "https://8000-cpod-1tr9chnikmqn.pod.compshare.cn",
    "api_key": "1a42e1e3eb4fbaaac216698be07291e8c88d33292e55bb24",
}
# ==========================


def _request(path, method="GET", timeout=30):
    """发起 HTTP 请求，返回 (status_code, json_data 或 text)。"""
    url = f"{_CONFIG['base_url']}{path}"
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", f"Bearer {_CONFIG['api_key']}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(body)
            except json.JSONDecodeError:
                return resp.status, body
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        try:
            return e.code, json.loads(body)
        except json.JSONDecodeError:
            return e.code, body
    except Exception as e:
        return -1, str(e)


def _print_json(data, title=None):
    """美化打印 JSON。"""
    if title:
        print(f"\n{'=' * 60}")
        print(f"  {title}")
        print(f"{'=' * 60}")
    else:
        print()
    if isinstance(data, (dict, list)):
        print(json.dumps(data, indent=2, ensure_ascii=False))
    else:
        print(data)


def query_one(job_id, auto_download=True):
    """查询单个任务状态。进度 100% 时自动下载视频。"""
    code, data = _request(f"/v1/videos/{job_id}")
    if code == 200:
        _print_json(data, f"任务状态：{job_id}")
        # 状态解读
        status = data.get("status", "unknown")
        progress = data.get("progress", 0)
        print(f"\n  → 状态：{status}，进度：{progress}%")
        if status == "completed" or progress >= 100:
            print(f"  → 视频地址：{_CONFIG['base_url']}{data.get('url', '')}")
            # 进度 100% 自动下载
            if auto_download:
                print()
                download_video(job_id)
        elif status == "failed":
            print(f"  → 错误：{data.get('error')}")
    else:
        _print_json(data, f"查询失败（HTTP {code}）")
    return code, data


def list_recent(limit=10):
    """列出最近的任务。"""
    code, data = _request(f"/v1/videos?limit={limit}&order=desc")
    if code == 200:
        items = data.get("data", []) if isinstance(data, dict) else data
        print(f"\n最近 {len(items)} 个任务：")
        print(f"{'-' * 90}")
        print(f"{'job_id':<42} {'状态':<12} {'进度':<8} {'时长':<6} {'创建时间'}")
        print(f"{'-' * 90}")
        for v in items:
            job_id = v.get("id", "")
            status = v.get("status", "")
            progress = v.get("progress", 0)
            seconds = v.get("seconds", "?")
            created = v.get("created_at", "")
            if created:
                created_str = time.strftime("%m-%d %H:%M:%S", time.localtime(created))
            else:
                created_str = "-"
            print(f"{job_id:<42} {status:<12} {progress:<8} {seconds:<6} {created_str}")
        print(f"{'-' * 90}")
        print(f"共 {len(items)} 条（限制 {limit}）")
    else:
        _print_json(data, f"列表失败（HTTP {code}）")
    return code, data


def poll_until_done(job_id, interval=5, max_wait=900):
    """轮询任务直到完成/失败/超时。"""
    print(f"\n开始轮询 {job_id}（每 {interval} 秒一次，最多 {max_wait} 秒）...")
    waited = 0
    last_progress = -1
    while waited <= max_wait:
        code, data = _request(f"/v1/videos/{job_id}")
        if code != 200:
            print(f"  查询出错（HTTP {code}）：{data}")
            time.sleep(interval)
            waited += interval
            continue
        status = data.get("status", "")
        progress = data.get("progress", 0)
        # 进度有变化才打印，避免刷屏
        if progress != last_progress or status not in ("in_progress", "queued"):
            ts = time.strftime("%H:%M:%S")
            print(f"  [{ts}] 状态={status}  进度={progress}%  （已等待 {waited}s）")
            last_progress = progress
        if status == "completed":
            print(f"\n✅ 任务完成！")
            _print_json(data, "完整返回数据")
            print(f"\n  视频下载地址：{_CONFIG['base_url']}{data.get('url', '')}（需带 Authorization 头）")
            return data
        if status == "failed":
            print(f"\n❌ 任务失败！")
            _print_json(data, "完整返回数据")
            return data
        time.sleep(interval)
        waited += interval
    print(f"\n⏰ 轮询超时（{max_wait}秒）")
    return None


def download_video(job_id, save_path=None):
    """下载已完成任务的视频。"""
    # 先查状态
    code, data = _request(f"/v1/videos/{job_id}")
    if code != 200:
        print(f"查询失败：{data}")
        return
    if data.get("status") != "completed":
        print(f"任务未完成（当前状态：{data.get('status')}），无法下载")
        return
    # 下载
    if not save_path:
        save_path = f"{job_id}.mp4"
    content_url = data.get("url", f"/v1/videos/{job_id}/content")
    url = f"{_CONFIG['base_url']}{content_url}"
    print(f"正在下载：{url}")
    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Bearer {_CONFIG['api_key']}")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            total = 0
            with open(save_path, "wb") as f:
                while True:
                    chunk = resp.read(8192)
                    if not chunk:
                        break
                    f.write(chunk)
                    total += len(chunk)
            print(f"✅ 下载完成：{save_path}（{total} 字节 / {total / 1024:.1f} KB）")
    except Exception as e:
        print(f"❌ 下载失败：{e}")


def check_health():
    """检查服务健康状态。"""
    code, data = _request("/health")
    _print_json(data, f"服务健康状态（HTTP {code}）")
    return code, data


def main():
    parser = argparse.ArgumentParser(
        description="自部署 MiniMax-H3 视频生成服务 - 手动测试工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例：
  python query_video.py                              # 列出最近 10 个任务
  python query_video.py video_xxx                    # 查询指定任务状态
  python query_video.py --poll video_xxx             # 轮询直到完成
  python query_video.py --download video_xxx         # 下载已完成任务的视频
  python query_video.py --health                     # 检查服务健康
  python query_video.py --list 20                    # 列出最近 20 个任务
        """,
    )
    parser.add_argument("job_id", nargs="?", default=None, help="任务 ID（video_xxx）")
    parser.add_argument("--poll", metavar="JOB_ID", help="轮询指定任务直到完成/失败")
    parser.add_argument("--download", metavar="JOB_ID", help="下载已完成任务的视频")
    parser.add_argument("--list", type=int, metavar="N", help="列出最近 N 个任务")
    parser.add_argument("--health", action="store_true", help="检查服务健康状态")
    parser.add_argument("--no-download", action="store_true", help="查询已完成任务时不自动下载视频")
    parser.add_argument("--base-url", default=None, help="覆盖服务地址")
    parser.add_argument("--key", default=None, help="覆盖 API Key")
    args = parser.parse_args()

    if args.base_url:
        _CONFIG["base_url"] = args.base_url.rstrip("/")
    if args.key:
        _CONFIG["api_key"] = args.key

    print(f"服务地址：{_CONFIG['base_url']}")

    if args.health:
        check_health()
    elif args.download:
        download_video(args.download)
    elif args.poll:
        poll_until_done(args.poll)
    elif args.list:
        list_recent(args.list)
    elif args.job_id:
        query_one(args.job_id, auto_download=not args.no_download)
    else:
        # 默认：列出最近任务
        list_recent()


if __name__ == "__main__":
    main()
