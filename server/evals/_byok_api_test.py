# -*- coding: utf-8 -*-
"""BYOK API 端到端真实测试（临时）：HTTP 打 localhost:8000，验证 注册→建店→GET/PUT/validate 真实走 DB+加密+owner。"""
import asyncio
import os
import httpx

BASE = "http://localhost:8000/api/v1"
PHONE = "13900000888"
PWD = "byokTest8888"
MIMO = os.environ.get("MIMO_KEY", "")


async def go():
    async with httpx.AsyncClient(base_url=BASE, timeout=180, trust_env=False) as c:
        r = await c.post("/auth/register", json={"phone": PHONE, "password": PWD, "name": "BYOK测试老板"})
        print("register:", r.status_code, "" if r.status_code < 400 else r.text[:80])
        r = await c.post("/auth/login", json={"phone": PHONE, "password": PWD})
        print("login:", r.status_code)
        tok = r.json()["access_token"]
        H = {"Authorization": f"Bearer {tok}"}
        # 建店（已存则取现有）
        r = await c.post("/stores", json={"name": "BYOK验证台球", "city": "成都"}, headers=H)
        if r.status_code < 400:
            sid = r.json()["id"]
            print("create store:", r.status_code, sid)
        else:
            r = await c.get("/stores/me", headers=H)
            sid = r.json()["id"]
            print("已有门店:", sid)
        H["X-Store-Id"] = sid
        # GET（无需主密钥）
        r = await c.get("/stores/me/byok", headers=H)
        print("GET byok:", r.status_code, r.text[:160])
        # PUT（需主密钥；dev server 没配 BYOK_ENCRYPT_KEY 会 503）
        body = {"enabled": True, "base_url": "https://api.xiaomimimo.com/v1", "api_key": MIMO, "model": "mimo-v2.5"}
        r = await c.put("/stores/me/byok", json=body, headers=H)
        print("PUT byok:", r.status_code, r.text[:200])
        # GET 再读（确认 enabled + key 脱敏，不回显明文）
        r = await c.get("/stores/me/byok", headers=H)
        print("GET byok(写后):", r.status_code, r.text[:200])
        # validate（真发测试请求到 MiMo）
        r = await c.post("/stores/me/byok/validate", json=body, headers=H)
        print("validate:", r.status_code, r.text[:200])


asyncio.run(go())
