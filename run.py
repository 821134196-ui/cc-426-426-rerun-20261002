#!/usr/bin/env python3
"""单条本地启动命令：初始化演示样例（排品 / 撤品 / 回执）并启动 Web 服务。

    python run.py                # 数据库为空时创建演示样例，然后启动
    python run.py --reset        # 重建演示样例（清空 SQLite 与样品照片）
    python run.py --port 8080
"""
from __future__ import annotations

import argparse
import sys

from live_room.seed import seed
from live_room.server import serve


def main() -> None:
    ap = argparse.ArgumentParser(description="直播间排品脚本与挂链审核系统")
    ap.add_argument("--reset", action="store_true", help="重建演示样例")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()

    summary = seed(reset=args.reset)
    if summary.get("skipped"):
        print("ℹ️  已有演示数据，直接启动（加 --reset 可重建）")
    print()
    serve(args.host, args.port)


if __name__ == "__main__":
    sys.exit(main())
