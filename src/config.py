from __future__ import annotations

import json
import os
from pathlib import Path

from dotenv import load_dotenv
from pydantic_settings import BaseSettings

load_dotenv()

PROJECT_ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    supabase_url: str = ""
    supabase_service_key: str = ""

    shopify_shop_domain: str = ""
    shopify_access_token: str = ""
    shopify_client_id: str = ""
    shopify_client_secret: str = ""

    amazon_sp_client_id: str = ""
    amazon_sp_client_secret: str = ""
    amazon_sp_refresh_token: str = ""
    amazon_sp_marketplace_id: str = "ATVPDKIKX0DER"

    telegram_bot_token: str = ""
    telegram_chat_id: str = ""

    smtp_host: str = "smtp.gmail.com"
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    alert_email_to: str = ""

    incoming_dir: str = str(PROJECT_ROOT / "incoming")
    archive_dir: str = str(PROJECT_ROOT / "archive")
    shopify_poll_interval_hours: int = 4
    folder_watch_interval_seconds: int = 60
    alert_days_before_deadline: int = 14
    economic_nexus_warn_percent: int = 80
    economic_nexus_caution_percent: int = 50

    @property
    def incoming_path(self) -> Path:
        return Path(self.incoming_dir).expanduser()

    @property
    def archive_path(self) -> Path:
        return Path(self.archive_dir).expanduser()

    @property
    def telegram_enabled(self) -> bool:
        return bool(self.telegram_bot_token and self.telegram_chat_id)

    @property
    def email_enabled(self) -> bool:
        return bool(self.smtp_user and self.smtp_password and self.alert_email_to)

    @property
    def shopify_enabled(self) -> bool:
        return bool(
            self.shopify_shop_domain
            and (self.shopify_access_token
                 or (self.shopify_client_id and self.shopify_client_secret))
        )

    @property
    def amazon_sp_enabled(self) -> bool:
        return bool(
            self.amazon_sp_client_id
            and self.amazon_sp_client_secret
            and self.amazon_sp_refresh_token
        )

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()


def load_state_rules() -> dict:
    path = PROJECT_ROOT / "config" / "state_rules.json"
    with open(path) as f:
        return json.load(f)


def load_fc_codes() -> dict[str, str]:
    path = PROJECT_ROOT / "config" / "fc_codes.json"
    with open(path) as f:
        data = json.load(f)
    return data.get("fc_codes", {})
