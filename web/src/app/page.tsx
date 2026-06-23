import { redirect } from "next/navigation";

/* 桌面本机单用户·免登录：首页直达 AI 对话窗口。 */
export default function Home() {
  redirect("/dashboard/chat");
}
