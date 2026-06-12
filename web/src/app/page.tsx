import { redirect } from "next/navigation";

/* 落地页暂不上线(后续还要调):生产环境首页直达登录。
 * 落地页代码保留在 /landing-preview(无任何入口链接,仅内部预览调样式用),
 * 正式启用时把 landing-preview/page.tsx 的内容搬回本文件即可。 */
export default function Home() {
  redirect("/login");
}
