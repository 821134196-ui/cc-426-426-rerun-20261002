"""HTTP 服务启动。"""
from __future__ import annotations

from functools import partial
from http.server import ThreadingHTTPServer

from .api import ApiHandler


def serve(host: str = "127.0.0.1", port: int = 8000) -> None:
    server = ThreadingHTTPServer((host, port), ApiHandler)
    print(f"🌊 直播间排品系统已启动：http://{host}:{port}")
    print("   Ctrl+C 停止")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        server.server_close()


if __name__ == "__main__":
    serve()
