from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings

# 项目根目录（server/ 的父目录）
_PROJECT_ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    # 运行环境
    app_env: str = "development"  # development | production

    # 数据库
    postgres_host: str = "localhost"
    postgres_port: int = 5432
    postgres_user: str = "postgres"
    postgres_password: str = "postgres"
    postgres_db: str = "billiards_ai"

    # 桌面全本地版：整条 DB URL 直给（如 sqlite+aiosqlite:////abs/path/billiards_local.db）。
    # 留空 = web 版，按上方 postgres_* 拼 PostgreSQL URL（生产行为完全不变）。
    # 别名 DATABASE_URL：env DATABASE_URL 设了就走它，否则保持 PG。
    database_url_override: str = Field(default="", alias="DATABASE_URL")

    # SECRET_KEY：审批签名 HMAC 用（services/agent/approval.py）。JWT 登录已删，不再有 jwt_* 配置。
    secret_key: str = ""

    # 文件上传（绝对路径）
    upload_dir: str = str(_PROJECT_ROOT / "uploads")

    # AI Provider
    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com"
    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com/v1"

    # BYOK：加密门店自带 API Key 的主密钥（Fernet 44 字符 base64）。从 env BYOK_ENCRYPT_KEY 注入，不进代码库。
    byok_encrypt_key: str = ""

    # 生图并发与超时（依据 OpenAI 账户 IPM 限额 + "生图慢、绝不重试"策略，详见 CLAUDE.md「AI 并发与限流」）
    # gpt-image-2 单张可能 5-10 分钟：读超时必须覆盖真实耗时，否则慢但已成功的图被判超时失败=钱花了图没拿到
    openai_image_timeout: float = 900.0
    # 每个 worker 同时在跑的生图数上限（asyncio 信号量）。生产 2 worker → 实际全局并发≈2×本值。
    # 当前账户 L2（IPM=20）：默认 4/worker → 实际≈8 并发，远低于 20；生图慢，一分钟根本起不到 20 张，
    # 超出的请求只是排队等待、不会触发 OpenAI 429。BYOK 供应商账号提额(IPM 更高)或想让用户少排队，经环境变量 POSTER_MAX_CONCURRENCY 上调即可。
    poster_max_concurrency: int = 4

    # 阿里云 OSS
    oss_access_key_id: str = ""
    oss_access_key_secret: str = ""
    oss_endpoint: str = ""
    oss_bucket_name: str = ""

    # CORS
    cors_origins: str = "http://localhost:3000,http://localhost:3001"

    # 内置模型对用户的【展示名】：换内置模型时只改这里(.env.bundled.local 里的 BUNDLED_*_LABEL)，
    # 前端跟着变、不用动代码——支持以后把 MiMo 换成别的模型还保持界面一致。
    bundled_model_label: str = "MiMo V2.5"     # 对话/看图大脑
    bundled_image_label: str = "GPT Image-2"   # 生图

    # 当前启用的模型 Provider
    text_model_provider: str = "deepseek"
    text_model_name: str = "deepseek-v4-flash"
    image_model_provider: str = "openai"
    image_model_name: str = ""

    # 火山方舟 key 仍供 Seedream 生图和真实素材剪辑里的豆包/VLM dev-only 直连兜底使用。
    ark_api_key: str = ""                                              # env ARK_API_KEY

    # 编排大脑（Agent 规划/选工具用）——与「内容生成」分离，可独立切换。
    # 留空 = 跟随 text_model_*（零配置即全 DeepSeek，不改现状）。
    # 规划可靠性不足时，把 provider/name 切到 GLM-4.6（OpenAI 兼容：注册 GLM provider + 配 base_url/key 即可）。
    orchestration_model_provider: str = ""
    orchestration_model_name: str = ""

    # 数据汇聚上行（默认关，桌面 env 开）：把本机使用数据静默汇聚到 owner 服务器。
    # 真 endpoint/token 走 .env.bundled.local 注入（同内置 key），不写死进 git。
    data_sync_enabled: bool = False        # DATA_SYNC_ENABLED
    data_sync_endpoint: str = ""           # DATA_SYNC_ENDPOINT 接收端 URL（经 nginx/443）
    data_sync_token: str = ""              # DATA_SYNC_TOKEN 可吊销 app 令牌
    data_sync_interval_s: int = 300        # DATA_SYNC_INTERVAL_S 上行周期
    data_sync_batch: int = 200             # DATA_SYNC_BATCH 每批条数

    @property
    def database_url(self) -> str:
        # 桌面本地版：env DATABASE_URL 已设则直接用（SQLite），不走 PG 拼接
        if self.database_url_override:
            return self.database_url_override
        return (
            f"postgresql+asyncpg://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @property
    def sync_database_url(self) -> str:
        """Alembic 使用的同步 database URL"""
        return (
            f"postgresql://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @property
    def effective_orchestration_provider(self) -> str:
        """编排大脑 provider 名；留空则跟随生成 provider。"""
        return self.orchestration_model_provider or self.text_model_provider

    @property
    def effective_orchestration_model(self) -> str:
        """编排大脑模型名；留空则跟随生成模型。"""
        return self.orchestration_model_name or self.text_model_name

    model_config = {
        "env_file": ".env",
        "case_sensitive": False,
        "extra": "ignore",
        "populate_by_name": True,  # 允许用字段名 database_url_override 直接赋值（别名 DATABASE_URL 仍生效）
    }


settings = Settings()

# 确保上传目录存在
Path(settings.upload_dir).mkdir(parents=True, exist_ok=True)


def validate_production_config() -> list[str]:
    """检查生产环境必须修改的配置项，返回警告列表。"""
    warnings: list[str] = []

    if settings.app_env != "production":
        return warnings

    if not settings.secret_key:
        warnings.append("secret_key 为空，审批签名 HMAC 不安全，请设置随机密钥")

    if settings.postgres_password == "postgres":
        warnings.append("postgres_password 使用默认值 'postgres'，生产环境请设置强密码")

    if "localhost" in settings.cors_origins:
        warnings.append("cors_origins 包含 localhost，生产环境请设置为实际域名")

    return warnings
