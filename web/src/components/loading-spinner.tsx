export function LoadingSpinner({ text = "加载中..." }: { text?: string }) {
  return (
    <div className="flex items-center justify-center py-16">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
      <span className="ml-3 text-sm text-gray-500">{text}</span>
    </div>
  );
}
