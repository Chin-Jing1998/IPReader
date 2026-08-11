import { JSX } from "preact"
import { createScrollEdgeScript } from "../util/scrollEdge"

const OverflowList = ({
  children,
  ...props
}: JSX.HTMLAttributes<HTMLUListElement> & { id: string }) => {
  return (
    <ul {...props} class={[props.class, "overflow"].filter(Boolean).join(" ")} id={props.id}>
      {children}
      <li class="overflow-end" />
    </ul>
  )
}

let numLists = 0
export default () => {
  const id = `list-${numLists++}`

  return {
    OverflowList: (props: JSX.HTMLAttributes<HTMLUListElement>) => (
      <OverflowList {...props} id={id} />
    ),
    overflowListAfterDOMLoaded: createScrollEdgeScript(id),
  }
}
