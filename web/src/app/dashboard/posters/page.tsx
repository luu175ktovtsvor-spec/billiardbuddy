"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/auth-context";
import { api } from "@/lib/api";
import type { StoreResponse } from "@/types/store";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Plus, MessageSquare, Loader2 } from "lucide-react";
import { EmptyStoreGuide } from "@/components/empty-store-guide";

interface ConversationItem {
  id: string;
  title: string;
  message_count: number;
  thumbnail_url: string | null;
  created_at: string;
  updated_at: string;
}

export default function PostersPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const router = useRouter();

  const [store, setStore] = useState<StoreResponse | null | undefined>(undefined);
  const [storeLoading, setStoreLoading] = useState(true);
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);

  /* Load store */
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    setStoreLoading(true);
    api.getMyStore()
      .then((s) => { if (!cancelled) setStore(s); })
      .catch(() => { if (!cancelled) setStore(null); })
      .finally(() => { if (!cancelled) setStoreLoading(false); });
    return () => { cancelled = true; };
  }, [isAuthenticated]);

  /* Load conversations */
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    setLoading(true);
    api.listPosterConversations()
      .then((data) => { if (!cancelled) setConversations(data.conversations || []); })
      .catch(() => { if (!cancelled) setConversations([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isAuthenticated]);

  const handleNew = () => {
    router.push("/dashboard/posters/new");
  };

  const handleOpen = (conv: ConversationItem) => {
    router.push(`/dashboard/posters/${conv.id}`);
  };

  const handleDelete = async (e: React.MouseEvent, conv: ConversationItem) => {
    e.stopPropagation();
    if (!confirm("确定删除这个对话？")) return;
    setDeleting(conv.id);
    try {
      await api.deletePosterConversation(conv.id);
      setConversations((prev) => prev.filter((c) => c.id !== conv.id));
    } catch {
      alert("删除失败，请重试");
    } finally {
      setDeleting(null);
    }
  };

  /* Loading */
  if (authLoading || storeLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-brand-600" />
      </div>
    );
  }
  if (!isAuthenticated) return null;
  if (store === null) {
    return <EmptyStoreGuide description="请先完善门店资料，然后再开始生成图片。" />;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Breadcrumb
        items={[
          { label: "返回首页", href: "/dashboard" },
          { label: "AI 生图" },
        ]}
      />

      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">AI 生图</h1>
        <button
          type="button"
          onClick={handleNew}
          className="flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-500 transition-colors"
        >
          <Plus className="h-4 w-4" />
          新建对话
        </button>
      </div>

      {/* Conversation list */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
        </div>
      ) : conversations.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white py-16 text-center">
          <MessageSquare className="mx-auto h-10 w-10 text-slate-300" />
          <p className="mt-3 text-sm text-slate-500">暂无对话记录</p>
          <button
            type="button"
            onClick={handleNew}
            className="mt-4 text-sm font-medium text-brand-600 hover:text-brand-500"
          >
            开始第一次生图
          </button>
        </div>
      ) : (
        <div className="grid gap-3">
          {conversations.map((conv) => (
            <div
              key={conv.id}
              onClick={() => handleOpen(conv)}
              className="group flex items-center gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm hover:shadow-md hover:border-brand-200 transition-all cursor-pointer"
            >
              {/* Thumbnail */}
              {conv.thumbnail_url ? (
                <img
                  src={api.resolveUrl(conv.thumbnail_url)}
                  alt=""
                  className="h-14 w-14 rounded-lg object-cover shrink-0"
                />
              ) : (
                <div className="h-14 w-14 rounded-lg bg-slate-100 flex items-center justify-center shrink-0">
                  <MessageSquare className="h-5 w-5 text-slate-400" />
                </div>
              )}

              {/* Info */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-800 truncate">
                  {conv.title}
                </p>
                <p className="mt-0.5 text-xs text-slate-400">
                  {conv.message_count} 轮对话 · {new Date(conv.updated_at).toLocaleDateString("zh-CN")}
                </p>
              </div>

              {/* Delete */}
              <button
                type="button"
                onClick={(e) => handleDelete(e, conv)}
                disabled={deleting === conv.id}
                className="opacity-0 group-hover:opacity-100 text-xs text-slate-400 hover:text-red-600 transition-opacity disabled:opacity-50"
              >
                {deleting === conv.id ? "删除中..." : "删除"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
