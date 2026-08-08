// 中文数字 → 阿拉伯（支持 1..999，含 十/十一/二十三/一百零五/一百四十九 等）。
//   实施细则条文可达三位数（如“第一百四十九条”），故需支持“百/千”单位。
//   抽出为共享模块，供数据管线（parse-guideline）与单元测试共用。
const CN = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const UNIT = { 十: 10, 百: 100, 千: 1000 };

export function cn2num(s) {
  if (!s) return NaN;
  if (/^\d+$/.test(s)) return parseInt(s, 10); // 已是阿拉伯数字
  let total = 0; // 累计
  let section = 0; // 当前单位前的数字
  let sawDigit = false; // 当前单位前是否出现过数字（处理“十一”这类省略十位）
  for (const ch of s) {
    if (ch in CN) {
      section = CN[ch];
      sawDigit = true;
    } else if (ch in UNIT) {
      // “十/百/千”前无数字时按 1 计（如“十一”=11）
      total += (sawDigit ? section : 1) * UNIT[ch];
      section = 0;
      sawDigit = false;
    } else {
      return NaN; // 非法字符
    }
  }
  total += section; // 末尾个位
  return total || NaN;
}
