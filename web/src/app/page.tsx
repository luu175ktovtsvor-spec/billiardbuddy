import { redirect } from "next/navigation";

/* 首页直达登录（桌面版同样从登录进）。 */
export default function Home() {
  redirect("/login");
}
