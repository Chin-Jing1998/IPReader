import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import style from "./styles/footer.scss"

interface Options {
  links: Record<string, string>
}

export default ((opts?: Options) => {
  const Footer: QuartzComponent = ({ displayClass }: QuartzComponentProps) => {
    const links = opts?.links ?? {}
    // 离线知识库：既无外链也无署名行时整件不渲染。
    // 保留空 <footer> 会因 footer.scss 的 margin-bottom: 4rem 在每页底部留出
    // 64px 空白；grid 的 grid-footer 行是 auto 高，元素消失后自然塌陷为 0。
    //
    // 关于署名：Quartz 为 MIT 许可，其义务是在软件副本中保留版权与许可全文
    // （即仓库内的 LICENSE.txt，原样保留），并不要求在运行输出的页面上署名。
    if (Object.keys(links).length === 0) {
      return null
    }
    return (
      <footer class={`${displayClass ?? ""}`}>
        <ul>
          {Object.entries(links).map(([text, link]) => (
            <li>
              <a href={link}>{text}</a>
            </li>
          ))}
        </ul>
      </footer>
    )
  }

  Footer.css = style
  return Footer
}) satisfies QuartzComponentConstructor
