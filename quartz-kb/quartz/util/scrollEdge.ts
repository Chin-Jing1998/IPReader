export interface ScrollEdgeMetrics {
  scrollTop: number
  clientHeight: number
  scrollHeight: number
}

export interface ScrollEdgeState {
  top: boolean
  bottom: boolean
}

const EDGE_TOLERANCE = 2

export function getScrollEdgeState({
  scrollTop,
  clientHeight,
  scrollHeight,
}: ScrollEdgeMetrics): ScrollEdgeState {
  return {
    top: scrollTop > EDGE_TOLERANCE,
    bottom: scrollTop + clientHeight < scrollHeight - EDGE_TOLERANCE,
  }
}

export function createScrollEdgeScript(id: string): string {
  return `
document.addEventListener("nav", () => {
  const ul = document.getElementById("${id}")
  if (!ul) return

  const updateEdgeFade = () => {
    ul.classList.toggle("gradient-top-active", ul.scrollTop > ${EDGE_TOLERANCE})
    ul.classList.toggle(
      "gradient-active",
      ul.scrollTop + ul.clientHeight < ul.scrollHeight - ${EDGE_TOLERANCE},
    )
  }

  ul.addEventListener("scroll", updateEdgeFade, { passive: true })
  window.addCleanup(() => ul.removeEventListener("scroll", updateEdgeFade))
  updateEdgeFade()
})
`
}
