import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const explorerStyles = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../components/styles/explorer.scss"),
  "utf8",
)

test("目录层级留白保持收紧，增加深层条目的可用宽度", () => {
  const nestedListBlock = explorerStyles.match(/\.folder-outer > ul \{([\s\S]*?)\n  \}/)?.[1]

  assert.ok(nestedListBlock, "未找到目录层级列表样式")
  assert.match(nestedListBlock, /margin-left: 4px;/)
  assert.match(nestedListBlock, /padding-left: 0\.65rem;/)
  assert.match(nestedListBlock, /overflow: hidden;/)
})
