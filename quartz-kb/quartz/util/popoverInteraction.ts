export type PopoverLinkAction = "preview" | "navigate"

export type PopoverReturnState = {
  from: string
  to: string
}

export function createPopoverReturnState(from: string, to: string): PopoverReturnState {
  return { from, to }
}

/** 单击先预览，第二次及后续点击才执行正文导航。 */
export function popoverLinkAction(clickCount: number): PopoverLinkAction {
  return clickCount >= 2 ? "navigate" : "preview"
}

/** 比较页面地址时忽略锚点，避免目标页滚到标题后丢失返回按钮。 */
function pageUrl(value: string): string {
  try {
    const url = new URL(value, "http://localhost")
    url.hash = ""
    return url.toString()
  } catch {
    return value.split("#", 1)[0]
  }
}

export function isPopoverReturnTarget(currentUrl: string, state: PopoverReturnState): boolean {
  return pageUrl(currentUrl) === pageUrl(state.to)
}
