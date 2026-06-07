from pathlib import Path

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

    # JWT
    secret_key: str = ""
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 10080  # 7 天

    # 文件上传（绝对路径）
    upload_dir: str = str(_PROJECT_ROOT / "uploads")

    # AI Provider
    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com"
    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com/v1"

    # 阿里云 OSS
    oss_access_key_id: str = ""
    oss_access_key_secret: str = ""
    oss_endpoint: str = ""
    oss_bucket_name: str = ""

    # CORS
    cors_origins: str = "http://localhost:3000,http://localhost:3001"

    # 当前启用的模型 Provider
    text_model_provider: str = "deepseek"
    text_model_name: str = "deepseek-v4-flash"
    image_model_provider: str = "openai"
    image_model_name: str = ""

    @property
    def database_url(self) -> str:
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

    model_config = {"env_file": ".env", "case_sensitive": False, "extra": "ignore"}


settings = Settings()

# 确保上传目录存在
Path(settings.upload_dir).mkdir(parents=True, exist_ok=True)


def validate_production_config() -> list[str]:
    """检查生产环境必须修改的配置项，返回警告列表。"""
    warnings: list[str] = []

    if settings.app_env != "production":
        return warnings

    if not settings.secret_key:
        warnings.append("secret_key 为空，JWT 签名不安全，请设置随机密钥")

    if settings.postgres_password == "postgres":
        warnings.append("postgres_password 使用默认值 'postgres'，生产环境请设置强密码")

    if "localhost" in settings.cors_origins:
        warnings.append("cors_origins 包含 localhost，生产环境请设置为实际域名")

    return warnings
