"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
import { useAuth } from "@/hooks/auth-context";
import { ApiError } from "@/types/api";

export default function RegisterPage() {
  const { register } = useAuth();
  const searchParams = useSearchParams();
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // 从 URL 参数读取邀请码
  useEffect(() => {
    const code = searchParams.get("invite");
    if (code) {
      setInviteCode(code.toUpperCase());
    }
  }, [searchParams]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!phone || !password) {
      setError("请填写手机号和密码");
      return;
    }
    if (!/^\d{11}$/.test(phone)) {
      setError("请输入正确的11位手机号");
      return;
    }
    if (password.length < 8) {
      setError("密码至少8位");
      return;
    }

    setLoading(true);
    try {
      await register(phone, password, name || undefined, inviteCode || undefined);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.status === 409 ? "该手机号已注册" : err.detail || "注册失败");
      } else {
        setError("注册失败，请重试");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
      <h2 className="mb-6 text-lg font-semibold text-slate-900">注册</h2>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="phone" className="mb-1.5 block text-sm font-medium text-slate-700">
            手机号
          </label>
          <input
            id="phone"
            type="tel"
            maxLength={11}
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
            className="w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 transition-colors focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            placeholder="请输入11位手机号"
            autoComplete="tel"
          />
        </div>

        <div>
          <label htmlFor="name" className="mb-1.5 block text-sm font-medium text-slate-700">
            姓名 <span className="text-slate-400">(选填)</span>
          </label>
          <input
            id="name"
            type="text"
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 transition-colors focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            placeholder="请输入您的姓名"
            autoComplete="name"
          />
        </div>

        <div>
          <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-slate-700">
            密码
          </label>
          <div className="relative">
            <input
              id="password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 pr-10 text-sm text-slate-900 placeholder-slate-400 transition-colors focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              placeholder="请输入密码（至少8位）"
              autoComplete="new-password"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? "隐藏密码" : "显示密码"}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <div>
          <label htmlFor="inviteCode" className="mb-1.5 block text-sm font-medium text-slate-700">
            邀请码 <span className="text-slate-400">(选填)</span>
          </label>
          <input
            id="inviteCode"
            type="text"
            maxLength={8}
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
            className="w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 transition-colors focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            placeholder="输入邀请码加入门店"
            autoComplete="off"
          />
          <p className="mt-1 text-xs text-slate-400">有邀请码可直接加入对应门店</p>
        </div>

        {error && (
          <p className="text-sm text-red-600">{error}</p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-50"
        >
          {loading ? "注册中..." : "注册"}
        </button>
      </form>

      <p className="mt-5 text-center text-sm text-slate-500">
        已有账号？{" "}
        <Link href="/login" className="font-medium text-indigo-600 hover:text-indigo-500">
          登录
        </Link>
      </p>
    </div>
  );
}