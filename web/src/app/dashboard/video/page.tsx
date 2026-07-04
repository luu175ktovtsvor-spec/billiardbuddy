// 路由页面：/dashboard/video 的薄壳。Next 规定 page.tsx 只能有默认导出(+ metadata 等保留名)，
// 不能带自定义 prop、也不能有别的具名导出。真组件在同目录 VideoWorkspace.tsx(具名导出、带
// initialFromGen)，供 workbench handoff 复用；这里独立访问时不带 initialFromGen、handoff 自动跳过。
import { VideoWorkspacePage } from "./VideoWorkspace";

export default function Page() {
  return <VideoWorkspacePage />;
}
