from __future__ import annotations

import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

from src.config import settings
from src.db import insert_rows


def send_email(subject: str, body: str, html: bool = False) -> dict:
    if not settings.email_enabled:
        return {"sent": False, "error": "Email not configured"}

    msg = MIMEMultipart("alternative")
    msg["Subject"] = f"[Sales Tax Agent] {subject}"
    msg["From"] = settings.smtp_user
    msg["To"] = settings.alert_email_to

    content_type = "html" if html else "plain"
    msg.attach(MIMEText(body, content_type))

    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port) as server:
            server.starttls()
            server.login(settings.smtp_user, settings.smtp_password)
            server.send_message(msg)
        success = True
        error = None
    except Exception as e:
        success = False
        error = str(e)

    insert_rows("alerts", [{
        "alert_type": "email",
        "channel": "email",
        "subject": subject,
        "body": body,
        "severity": "info",
        "delivered": success,
        "error_message": error,
    }])

    return {"sent": success, "error": error}
