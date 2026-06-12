"use client";

import { useState, useRef, useEffect } from "react";
import { useAuth } from "@/hooks/auth-context";
import type { StoreListItem } from "@/types/store";
import { api } from "@/lib/api";
import { LogOut, ChevronDown, Store } from "lucide-react";
import Link from "next/link";

export function Header() {
  const { user, logout } = useAuth();
  const [stores, setStores] = useState<StoreListItem[]>([]);
  const [currentStore, setCurrentStore] = useState<StoreListItem | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    api.listStores().then((list) => {
      if (cancelled) return;
      setStores(list);
      if (list.length > 0) setCurrentStore(list[0]);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <header className="sticky top-0 z-30 hidden h-16 items-center justify-between border-b border-slate-200 bg-white/80 backdrop-blur-sm px-4 sm:px-6 lg:flex">
      {/* Left: Store switcher */}
      <div className="relative" ref={ref}>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
        >
          <Store className="h-4 w-4 text-slate-400" />
          <span className="max-w-[160px] truncate font-medium">
            {currentStore?.name || "选择门店"}
          </span>
          <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
        </button>

        {open && (
          <div className="absolute left-0 top-full mt-2 w-64 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg">
            {stores.length > 0 ? (
              stores.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => { setCurrentStore(s); api.setStoreId(s.id); setOpen(false); window.location.reload(); }}
                  className="flex w-full items-center rounded-lg px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                >
                  {s.name}
                </button>
              ))
            ) : (
              <Link
                href="/dashboard/store-settings"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-brand-600 hover:bg-slate-50"
              >
                <Store className="h-4 w-4" />
                创建门店
              </Link>
            )}
          </div>
        )}
      </div>

      {/* Right: User */}
      <div className="flex items-center gap-3">
        {user?.name && (
          <span className="hidden text-sm text-slate-500 sm:inline">{user.name}</span>
        )}
        <button
          type="button"
          onClick={logout}
          className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition-colors"
        >
          <LogOut className="h-4 w-4" />
          退出
        </button>
      </div>
    </header>
  );
}
