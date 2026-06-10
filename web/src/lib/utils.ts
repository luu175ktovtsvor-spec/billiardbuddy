import { ApiError } from "@/types/api";

export function getErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.status) {
      case 401: return "请重新登录";
      case 404: return "请先创建或完善门店资料";
      case 422: return "请检查输入内容";
      case 429: return "本月生成次数已达上限，请下月再试";
      case 500: return "生成失败，请稍后重试";
      default: return err.detail || `请求失败 (${err.status})`;
    }
  }
  if (err instanceof TypeError && err.message === "Failed to fetch") {
    return "网络异常，请检查后重试";
  }
  return "生成失败，请稍后重试";
}
