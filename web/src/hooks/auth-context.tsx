"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import type { User } from "@/types/auth";

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (phone: string, password: string) => Promise<void>;
  register: (phone: string, password: string, name?: string, inviteCode?: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();

  const fetchUser = useCallback(async () => {
    if (!api.isAuthenticated()) {
      setIsLoading(false);
      return;
    }
    try {
      const u = await api.getMe();
      setUser(u);
    } catch {
      api.setToken(null);
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  const login = useCallback(async (phone: string, password: string) => {
    const res = await api.login(phone, password);
    api.setToken(res.access_token);
    const u = await api.getMe();
    setUser(u);
    // 默认进普通用户工作台——有门店的账号（含"既是老板又是超管"的号）客户端体验与普通用户完全一致。
    // 只有「没有门店的纯平台超管账号」才直接进 /admin（它进 dashboard 没有门店可用）。
    let dest = "/dashboard";
    if (u.is_admin) {
      try {
        await api.getMyStore(); // 有门店 → 当普通用户进 dashboard
      } catch (err) {
        // 无门店：/stores/me 抛 403「不属于任何门店」(或 404)，纯平台超管才直接进 /admin；
        // 其它错误(网络/500)不误判，仍按普通用户进 dashboard
        const st = (err as { status?: number })?.status;
        if (st === 403 || st === 404) dest = "/admin";
      }
    }
    router.push(dest);
  }, [router]);

  const register = useCallback(async (phone: string, password: string, name?: string, inviteCode?: string) => {
    const res = await api.register({ phone, password, name, invite_code: inviteCode });
    api.setToken(res.access_token);
    const u = await api.getMe();
    setUser(u);
    router.push("/dashboard");
  }, [router]);

  const logout = useCallback(() => {
    api.setToken(null);
    api.setStoreId("");
    setUser(null);
    router.push("/login");
  }, [router]);

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated: !!user,
        login,
        register,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
