// 桌面本机单用户·免登录：SaaS 的注册/登录/token 类型已删，只留 owner 身份。
export interface User {
  id: string;
  phone: string;
  name: string | null;
  created_at: string;
}
