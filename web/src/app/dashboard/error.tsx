"use client";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[300px] items-center justify-center">
      <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-center">
        <p className="text-sm font-medium text-red-700">页面出错了</p>
        <p className="mt-1 text-xs text-red-500">{error.message}</p>
        <button
          onClick={reset}
          className="mt-3 rounded-md bg-red-600 px-3 py-1.5 text-xs text-white hover:bg-red-700"
        >
          重试
        </button>
      </div>
    </div>
  );
}
