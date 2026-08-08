import { getFullSlug } from "../../util/path"

const checkboxId = (index: number) => `${getFullSlug(window)}-checkbox-${index}`

document.addEventListener("nav", () => {
  const checkboxes = document.querySelectorAll(
    "input.checkbox-toggle",
  ) as NodeListOf<HTMLInputElement>
  checkboxes.forEach((el, index) => {
    const elId = checkboxId(index)

    const switchState = (e: Event) => {
      const newCheckboxState = (e.target as HTMLInputElement)?.checked ? "true" : "false"
      // ==== patent-kb: 每页每复选框一个键，键数无上限增长，最易先撞配额 ====
      try {
        localStorage.setItem(elId, newCheckboxState)
      } catch {
        // 勾选状态不持久化即可，不该让异常冒泡中断交互
      }
      // ==== /patent-kb ====
    }

    el.addEventListener("change", switchState)
    window.addCleanup(() => el.removeEventListener("change", switchState))
    if (localStorage.getItem(elId) === "true") {
      el.checked = true
    }
  })
})
