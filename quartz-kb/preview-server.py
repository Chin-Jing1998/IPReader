#!/usr/bin/env python3
# 用法：python3 preview-server.py public 8899
# 预览服务器：与 desktop/server.cjs 同语义的静态服务
#   decodeURI、目录→index.html、无扩展名→.html 回退——保证 SPA 导航与生产一致
import http.server, os, sys, urllib.parse

ROOT = sys.argv[1]
PORT = int(sys.argv[2])

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def send_head(self):
        path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
        fs = os.path.join(ROOT, path.lstrip('/'))
        if not os.path.exists(fs) and not path.endswith('/'):
            alt = fs + '.html'
            if os.path.isfile(alt):
                self.path = urllib.parse.urlparse(self.path).path + '.html'
        return super().send_head()

    def log_message(self, *a):
        pass

http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
