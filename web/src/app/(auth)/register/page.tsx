"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
import { useAuth } from "@/hooks/auth-context";
import { ApiError } from "@/types/api";

// Codex 风：浅色默认 · 跟随系统深浅色 · OpenAI 绿
const INPUT =
  "w-full rounded-lg border border-black/[0.08] bg-black/[0.02] px-3.5 py-2.5 text-[14px] text-[#1d1d1f] outline-none transition placeholder:text-[#b0b0b5] focus:border-[#10a37f]/50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-[#e6e7e9] dark:placeholder:text-[#56585f]";
const LABEL = "mb-1.5 block text-[13px] font-medium text-[#3a3a3c] dark:text-[#c8cace]";

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

  useEffect(() => {
    const code = searchParams.get("invite");
    if (code) setInviteCode(code.toUpperCase());
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
    <div className="rounded-xl border border-black/[0.06] bg-white p-7 shadow-sm dark:border-white/[0.08] dark:bg-[#16181d] dark:shadow-none">
      <h2 className="mb-6 text-[17px] font-semibold text-[#1d1d1f] dark:text-[#e6e7e9]">注册</h2>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="phone" className={LABEL}>手机号</label>
          <input id="phone" type="tel" maxLength={11} value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
            className={INPUT} placeholder="请输入11位手机号" autoComplete="tel" />
        </div>

        <div>
          <label htmlFor="name" className={LABEL}>姓名 <span className="text-[#a1a1a6] dark:text-[#6e7077]">(选填)</span></label>
          <input id="name" type="text" maxLength={100} value={name}
            onChange={(e) => setName(e.target.value)}
            className={INPUT} placeholder="请输入您的姓名" autoComplete="name" />
        </div>

        <div>
          <label htmlFor="password" className={LABEL}>密码</label>
          <div className="relative">
            <input id="password" type={showPassword ? "text" : "password"} value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={`${INPUT} pr-10`} placeholder="请输入密码（至少8位）" autoComplete="new-password" />
            <button type="button" onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? "隐藏密码" : "显示密码"}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[#86868b] transition hover:text-[#1d1d1f] dark:text-[#6e7077] dark:hover:text-[#c8cace]">
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <div>
          <label htmlFor="inviteCode" className={LABEL}>邀请码 <span className="text-[#a1a1a6] dark:text-[#6e7077]">(选填)</span></label>
          <input id="inviteCode" type="text" maxLength={8} value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
            className={INPUT} placeholder="输入邀请码加入门店" autoComplete="off" />
          <p className="mt-1 text-[12px] text-[#a1a1a6] dark:text-[#6e7077]">有邀请码可直接加入对应门店</p>
        </div>

        {error && <p className="text-[13px] text-[#ff3b30] dark:text-[#ff8585]">{error}</p>}

        <button type="submit" disabled={loading}
          className="w-full rounded-lg bg-[#10a37f] px-4 py-2.5 text-[14px] font-medium text-white transition hover:bg-[#0e906f] active:scale-[0.99] disabled:opacity-50">
          {loading ? "注册中…" : "注册"}
        </button>
      </form>

      <p className="mt-5 text-center text-[13px] text-[#86868b] dark:text-[#6e7077]">
        已有账号？{" "}
        <Link href="/login" className="font-medium text-[#10a37f] hover:text-[#0e906f]">登录</Link>
      </p>
    </div>
  );
}
