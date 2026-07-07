import type { NotificationItem } from "@/lib/api";

export function taskIdFromNotificationMeta(meta: unknown): string | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const record = meta as Record<string, unknown>;
  const taskId = typeof record.taskId === "string" ? record.taskId : typeof record.task_id === "string" ? record.task_id : "";
  const clean = taskId.trim();
  return clean ? clean : null;
}

export function taskIdFromNotification(item: Pick<NotificationItem, "kind" | "meta">): string | null {
  return item.kind === "background_task" ? taskIdFromNotificationMeta(item.meta) : null;
}
