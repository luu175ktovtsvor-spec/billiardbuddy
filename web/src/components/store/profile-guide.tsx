"use client";

import { CheckCircle, Circle } from "lucide-react";

interface ProfileField {
  label: string;
  done: boolean;
}

interface ProfileGuideProps {
  fields: ProfileField[];
  title?: string;
  description?: string;
}

export function ProfileGuide({
  fields,
  title = "建议先完成这些核心资料",
  description = "这些资料会被 AI 用来生成朋友圈文案、群公告、活动方案和海报。",
}: ProfileGuideProps) {
  const doneCount = fields.filter((f) => f.done).length;
  const totalCount = fields.length;

  return (
    <div className="rounded-lg border border-brand-200 bg-brand-50 p-4 sm:p-5 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-sm font-semibold text-slate-900">{title}</span>
        <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand-600">
          {doneCount}/{totalCount}
        </span>
      </div>
      <p className="mb-3 text-sm text-brand-600">{description}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {fields.map((field) => (
          <div
            key={field.label}
            className="flex items-center gap-2 rounded-md bg-white px-3 py-2 shadow-sm"
          >
            {field.done ? (
              <CheckCircle className="h-4 w-4 shrink-0 text-emerald-600" />
            ) : (
              <Circle className="h-4 w-4 shrink-0 text-slate-400" />
            )}
            <span
              className={
                field.done ? "text-sm text-slate-900" : "text-sm text-slate-500"
              }
            >
              {field.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
