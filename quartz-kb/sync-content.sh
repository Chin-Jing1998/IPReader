#!/bin/sh
# sync-content.sh —— 同步章节/词条详情 JSON 到 quartz 静态资源目录
#
# 作用：把 ../site/public/content/（2175 个节点详情 JSON：章节 related/examples、
#       词条 definition/occurrences/laws 等）拷入 quartz/static/content/，
#       quartz 每次 `npx quartz build` 会经 Static emitter 自动带到 public/static/content/，
#       供图谱总览页（0-图谱总览）等组件按节点 id 拉取侧栏阅读内容。
#
# 用法：在 quartz-kb 根目录执行 ./sync-content.sh
#       （site 侧重新生成 public/content/ 后需重跑本脚本 + quartz build）
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SRC="$SCRIPT_DIR/../site/public/content"
DEST="$SCRIPT_DIR/quartz/static/content"

if [ ! -d "$SRC" ]; then
  echo "错误：未找到 $SRC，请先在 site/ 内执行 npm run data:content 与 npm run data:terms-content" >&2
  exit 1
fi

# 幂等：先清空目标目录再整体拷贝，避免已删除节点的旧 JSON 残留
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$SRC/." "$DEST/"

echo "已同步：$SRC → $DEST"
find "$DEST" -type f | wc -l | awk '{print "文件数：" $1}'
