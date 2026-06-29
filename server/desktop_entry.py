# PyInstaller 打包入口：本地起 uvicorn 跑 FastAPI(main:app)，命令行 --host/--port。
#
# 知识库密钥（护城河）：打包时 desktop/scripts/build_backend.js 会把下面这行的占位符
# 替换成当次构建生成的 Fernet key（与生成 prompts.enc 用的是同一个）。运行时 PromptEngine
# 据此解密 bundle 根的 prompts.enc，加载加密知识库——安装包里没有明文 prompts/。
# setdefault：外部已设 PROMPTS_PACK_KEY（如调试）则尊重外部，不被烘进的值覆盖。
import os

os.environ.setdefault("PROMPTS_PACK_KEY", "__PROMPTS_PACK_KEY__")

# SECRET_KEY：main.py 强制非空才肯启动。桌面本地版（单机单用户）由 Electron 在 userData
# 持久化一个随机密钥并经 env 注入；若外部没给（如直接跑可执行自测），这里兜一个，保证能起。
# 不覆盖外部已设的值。
os.environ.setdefault("SECRET_KEY", "billiards-desktop-local-secret-change-me")

# 语义检索：装机包内置了 bge 模型(打包进 fastembed_cache)，默认启用真语义嵌入(店脑/知识"按
# 意思找料"，不再是词面匹配)。模型加载失败会自动回退词面版，不崩。外部已设则尊重。
os.environ.setdefault("RAG_EMBEDDER", "fastembed")

import sys  # noqa: E402

import uvicorn  # noqa: E402

# 强制 import：uvicorn.run("main:app") 是字符串，PyInstaller 静态分析不会跟进去收集 main 及其
# 全部依赖。这里显式 import 一下，让打包器把整个应用图都收进可执行。
import main  # noqa: E402,F401

if __name__ == "__main__":
    host, port = "127.0.0.1", 8077
    a = sys.argv[1:]
    for i, x in enumerate(a):
        if x == "--host" and i + 1 < len(a):
            host = a[i + 1]
        if x == "--port" and i + 1 < len(a):
            port = int(a[i + 1])
    uvicorn.run("main:app", host=host, port=port, log_level="info")
