import { describe, expect, it } from "vitest";

import { taskIdFromNotification, taskIdFromNotificationMeta } from "./notification-task-link";

describe("notification task links", () => {
  it("extracts background task ids from notification metadata", () => {
    expect(taskIdFromNotification({ kind: "background_task", meta: { taskId: " task_1 " } })).toBe("task_1");
    expect(taskIdFromNotification({ kind: "background_task", meta: { task_id: "task_2" } })).toBe("task_2");
  });

  it("ignores unrelated or invalid notification metadata", () => {
    expect(taskIdFromNotification({ kind: "info", meta: { taskId: "task_1" } })).toBeNull();
    expect(taskIdFromNotificationMeta({ taskId: "" })).toBeNull();
    expect(taskIdFromNotificationMeta(null)).toBeNull();
  });
});
