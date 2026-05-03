from __future__ import annotations

import json
import os
from functools import lru_cache
from typing import Any

from fastapi import Header, HTTPException, status


def _admin_emails() -> set[str]:
    return {
        email.strip().lower()
        for email in os.getenv("ADMIN_EMAILS", "").split(",")
        if email.strip()
    }


@lru_cache(maxsize=1)
def _firebase_app() -> Any | None:
    try:
        import firebase_admin
        from firebase_admin import credentials
    except Exception:
        return None

    if firebase_admin._apps:
        return firebase_admin.get_app()

    service_account_json = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON")
    service_account_path = os.getenv("FIREBASE_SERVICE_ACCOUNT_PATH")
    project_id = os.getenv("FIREBASE_PROJECT_ID")

    try:
        if service_account_json:
            info = json.loads(service_account_json)
            return firebase_admin.initialize_app(credentials.Certificate(info))
        if service_account_path:
            return firebase_admin.initialize_app(credentials.Certificate(service_account_path))
        if project_id:
            return firebase_admin.initialize_app(options={"projectId": project_id})
    except Exception:
        return None

    return None


def _extract_bearer(authorization: str | None) -> str:
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Operator authentication is required.",
        )
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Use Authorization: Bearer <token>.",
        )
    return token.strip()


async def require_admin(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    token = _extract_bearer(authorization)

    admin_token = os.getenv("SENTINEL_ADMIN_TOKEN")
    if admin_token and token == admin_token:
        return {"email": "token-admin", "auth": "sentinel-admin-token"}

    app = _firebase_app()
    if app is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Firebase admin verification is not configured.",
        )

    try:
        from firebase_admin import auth as firebase_auth

        decoded = firebase_auth.verify_id_token(token, app=app)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid Firebase operator token: {exc}",
        ) from exc

    email = str(decoded.get("email") or "").lower()
    allowed = _admin_emails()
    if allowed and email not in allowed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This Firebase user is not in ADMIN_EMAILS.",
        )
    return decoded
