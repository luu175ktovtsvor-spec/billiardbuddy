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
    // 平台超管账号不绑门店，进 /dashboard 会因"无门店"报错，直接导向独立后台
    router.push(u.is_admin ? "/admin" : "/dashboard");
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
