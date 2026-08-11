import assert from "node:assert/strict"
import test from "node:test"
import {
  MIN_THUMB_HEIGHT,
  computeThumbGeometry,
  hasScrollableContent,
  scrollTopFromThumbOffset,
} from "./scrollInteraction"

// 需求⑨：shouldChainWheelToPage 的三个用例（到底/到顶交给整页、未到边界不交）
// 随该函数一并删除——侧栏边界不再把滚轮转发给正文，改由 CSS overscroll-behavior:
// contain 阻断，无 JS 逻辑可断言。
// 自绘 overlay 滚动条替换原生滚动槽后，getSidebarScrollbarPresentation 的两个
// 用例（保留槽位/只显拇指）同样删除，改测 thumb 几何映射。

test("有纵向溢出的侧栏内容需要支持滚动条显示", () => {
  assert.equal(
    hasScrollableContent({
      clientWidth: 320,
      scrollWidth: 320,
      clientHeight: 300,
      scrollHeight: 500,
    }),
    true,
  )
})

test("没有溢出的侧栏内容不显示滚动条", () => {
  assert.equal(
    hasScrollableContent({
      clientWidth: 320,
      scrollWidth: 320,
      clientHeight: 300,
      scrollHeight: 300,
    }),
    false,
  )
})

test("内容未溢出时 overlay 滚动条不可见", () => {
  // Arrange：内容高度与可视高度一致，处于容差之内
  const metrics = { clientHeight: 300, scrollHeight: 300, scrollTop: 0 }

  // Act
  const geometry = computeThumbGeometry(metrics, 400)

  // Assert
  assert.deepEqual(geometry, { visible: false, height: 0, offset: 0 })
})

test("常规溢出时 thumb 高度按可视比例占据轨道", () => {
  // Arrange：可视 300 / 内容 1200，占比 1/4
  const metrics = { clientHeight: 300, scrollHeight: 1200, scrollTop: 0 }
  const trackHeight = 400

  // Act
  const geometry = computeThumbGeometry(metrics, trackHeight)

  // Assert
  assert.equal(geometry.visible, true)
  assert.equal(geometry.height, (trackHeight * metrics.clientHeight) / metrics.scrollHeight)
  assert.equal(geometry.height, 100)
  assert.equal(geometry.offset, 0)
})

test("省略轨道高度时以可视高度作为轨道高度换算", () => {
  // Arrange
  const metrics = { clientHeight: 300, scrollHeight: 900, scrollTop: 0 }

  // Act
  const geometry = computeThumbGeometry(metrics)

  // Assert
  assert.equal(geometry.height, computeThumbGeometry(metrics, metrics.clientHeight).height)
  assert.equal(geometry.height, 100)
})

test("内容极长时 thumb 高度钳制在最小值 28", () => {
  // Arrange：按比例仅 1.2px，低于最小命中高度
  const metrics = { clientHeight: 300, scrollHeight: 100_000, scrollTop: 0 }

  // Act
  const geometry = computeThumbGeometry(metrics, 400)

  // Assert
  assert.equal(MIN_THUMB_HEIGHT, 28)
  assert.equal(geometry.height, MIN_THUMB_HEIGHT)
  assert.equal(geometry.visible, true)
})

test("滚动到底时 thumb 紧贴轨道底部", () => {
  // Arrange：scrollTop 取最大值 1200 - 300
  const trackHeight = 400
  const metrics = { clientHeight: 300, scrollHeight: 1200, scrollTop: 900 }

  // Act
  const geometry = computeThumbGeometry(metrics, trackHeight)

  // Assert
  assert.equal(geometry.offset, trackHeight - geometry.height)
  assert.equal(geometry.offset, 300)
})

test("拖拽逆映射与 thumb 偏移正映射往返一致", () => {
  // Arrange：取首尾与中间若干滚动位置采样
  const trackHeight = 387
  const metrics = { clientHeight: 300, scrollHeight: 1234, scrollTop: 0 }

  for (const scrollTop of [0, 137, 500, 934]) {
    // Act
    const geometry = computeThumbGeometry({ ...metrics, scrollTop }, trackHeight)
    const roundtrip = scrollTopFromThumbOffset(
      geometry.offset,
      metrics,
      trackHeight,
      geometry.height,
    )

    // Assert
    assert.ok(
      Math.abs(roundtrip - scrollTop) < 0.5,
      `scrollTop=${scrollTop} 往返得到 ${roundtrip}，偏差超过 0.5px`,
    )
  }
})

test("越界的拖拽偏移被钳制在可滚动区间内", () => {
  // Arrange
  const metrics = { clientHeight: 300, scrollHeight: 1200, scrollTop: 0 }

  // Act & Assert
  assert.equal(scrollTopFromThumbOffset(-50, metrics, 400, 100), 0)
  assert.equal(scrollTopFromThumbOffset(9999, metrics, 400, 100), 900)
})

test("轨道与 thumb 等高时逆映射返回 0", () => {
  // Arrange：无可拖动余量，避免除零
  const metrics = { clientHeight: 300, scrollHeight: 1200, scrollTop: 0 }

  // Act
  const scrollTop = scrollTopFromThumbOffset(120, metrics, 300, 300)

  // Assert
  assert.equal(scrollTop, 0)
})

// 以下两例覆盖 trackHeight ≠ clientHeight 的情形：轨道短于可视区（400 vs 600）时，
// thumb 高度与偏移都必须按轨道长度换算，而不是按可视高度。上方既有用例的
// trackHeight 均等于或大于 clientHeight，未触及这条缩放路径。
test("轨道短于可视区时 thumb 几何按轨道长度缩放", () => {
  // Arrange：可视 600 / 内容 1800，占比 1/3；滚动到行程中点
  const metrics = { clientHeight: 600, scrollHeight: 1800, scrollTop: 600 }
  const trackHeight = 400

  // Act
  const geometry = computeThumbGeometry(metrics, trackHeight)

  // Assert：height = 400 × 600 / 1800，未触及 28 的下限；offset 取可拖动余量的一半
  assert.equal(geometry.visible, true)
  assert.ok(
    Math.abs(geometry.height - 133.33) < 0.5,
    `thumb 高度为 ${geometry.height}，偏离 133.33 超过 0.5px`,
  )
  assert.ok(
    Math.abs(geometry.offset - 133.33) < 0.5,
    `thumb 偏移为 ${geometry.offset}，偏离 133.33 超过 0.5px`,
  )
})

test("轨道短于可视区且滚动到底时 thumb 底边贴合轨道末端", () => {
  // Arrange：scrollTop 取最大值 1800 - 600
  const metrics = { clientHeight: 600, scrollHeight: 1800, scrollTop: 1200 }
  const trackHeight = 400

  // Act
  const geometry = computeThumbGeometry(metrics, trackHeight)

  // Assert：到底时 thumb 末端与轨道末端重合，不得因缩放留下缝隙
  assert.ok(
    Math.abs(geometry.offset + geometry.height - trackHeight) < 0.5,
    `thumb 末端落在 ${geometry.offset + geometry.height}，与轨道末端 ${trackHeight} 偏离超过 0.5px`,
  )
})
