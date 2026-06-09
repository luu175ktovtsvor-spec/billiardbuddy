"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface Plan {
  id: string;
  name: string;
  slug: string;
  price_monthly: number;
  generation_limit: number;
  token_limit: number;
  poster_limit: number;
  max_members: number;
  is_active: boolean;
}

export default function AdminPlansPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const token = api.getToken();
    fetch(`${api.baseUrl}/api/v1/admin/plans`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => res.json())
      .then((data) => { if (!cancelled) setPlans(data); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading) return <div className="py-20 text-center text-slate-500">加载中...</div>;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">套餐管理</h1>
      <div className="grid grid-cols-3 gap-6">
        {plans.map((plan) => (
          <div key={plan.id} className="rounded-lg border bg-white p-6 shadow-sm">
            <h3 className="font-bold text-lg">{plan.name}</h3>
            <p className="text-2xl font-bold my-2">
              ¥{plan.price_monthly / 100}<span className="text-sm font-normal">/月</span>
            </p>
            <ul className="space-y-1 text-sm text-slate-600">
              <li>每月 {plan.generation_limit} 次生成</li>
              <li>{plan.token_limit.toLocaleString()} tokens</li>
              <li>{plan.poster_limit} 张海报</li>
              <li>{plan.max_members} 个成员</li>
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
