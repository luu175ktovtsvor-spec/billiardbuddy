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
  register: (phone: string, password: string, name?: string) => Promise<void>;
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
    // 单窗口产品：登录后落地唯一窗口「AI agent 会话」。
    router.push("/dashboard/chat");
  }, [router]);

  const register = useCallback(async (phone: string, password: string, name?: string) => {
    const res = await api.register({ phone, password, name });
    api.setToken(res.access_token);
    const u = await api.getMe();
    setUser(u);
    router.push("/dashboard/chat");
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
