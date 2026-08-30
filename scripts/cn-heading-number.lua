-- cn-heading-number.lua —— 中文标题自动编号 pandoc filter
--
-- 用途：Markdown → .docx 转档时，为标题按中文公文惯例自动加编号前缀。
--   H1 → 一、二、三…（中文数字 + 顿号）
--   H2 → （一）（二）…（全角括号 + 中文数字），在每个 H1 下重置
--   H3 → 1. 2. …（阿拉伯数字 + 点 + 半角空格），在每个 H2 下重置
--   H4 及以下不加编号（原样返回）。
--
-- 来源：阶段5.11 收尾勘误批（提交 a7658907，2026-08-31）为重转 使用说明.docx
-- 而写，规则复刻该 docx 8/26 旧版的既有编号形态，使新旧档编号逐字一致。
-- 原件位于 /tmp/cn-heading-number.lua，因 /tmp 会被系统清理，v1.6.0 打包批
-- （2026-08-31）将其固化入仓，成为本仓 Markdown → Word 转档的既定组件。
--
-- 用法（reference-doc 取既有 docx 自身，以逐字继承样式定义）：
--   pandoc 使用说明.md -o 使用说明.docx \
--     --reference-doc=使用说明.docx --lua-filter=scripts/cn-heading-number.lua
--
-- 注意：本 filter 只加前缀、不改标题层级，故 md 源文件中标题**不得**自带编号，
-- 否则会与本 filter 的前缀叠加成「一、一、xxx」。

local c1, c2, c3 = 0, 0, 0

local digits = { "〇", "一", "二", "三", "四", "五", "六", "七", "八", "九" }

-- 1..99 的中文数字（十、十一、二十、二十一…）
local function cn_num(n)
  if n <= 0 then return tostring(n) end
  if n < 10 then return digits[n + 1] end
  if n == 10 then return "十" end
  if n < 20 then return "十" .. digits[(n % 10) + 1] end
  local tens = math.floor(n / 10)
  local ones = n % 10
  if ones == 0 then return digits[tens + 1] .. "十" end
  return digits[tens + 1] .. "十" .. digits[ones + 1]
end

function Header(el)
  local prefix
  if el.level == 1 then
    c1 = c1 + 1
    c2, c3 = 0, 0
    prefix = cn_num(c1) .. "、"
  elseif el.level == 2 then
    c2 = c2 + 1
    c3 = 0
    prefix = "（" .. cn_num(c2) .. "）"
  elseif el.level == 3 then
    c3 = c3 + 1
    prefix = tostring(c3) .. ". "
  else
    return nil
  end
  table.insert(el.content, 1, pandoc.Str(prefix))
  return el
end
