"""Who is calling: verify the Supabase access token sent by the Next.js app.

The browser signs in with Supabase anonymous sign-in and sends
`Authorization: Bearer <access_token>` on every API call.
"""

from dataclasses import dataclass
from functools import lru_cache
from typing import Annotated
from uuid import UUID

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import Settings, get_settings

_bearer = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class CurrentUser:
    id: UUID
    claims: dict


@lru_cache
def _jwks_client(supabase_url: str) -> jwt.PyJWKClient:
    return jwt.PyJWKClient(f"{supabase_url.rstrip('/')}/auth/v1/.well-known/jwks.json")


def decode_token(token: str, settings: Settings) -> dict:
    if settings.supabase_jwt_secret:
        return jwt.decode(
            token, settings.supabase_jwt_secret, algorithms=["HS256"],
            audience=settings.jwt_audience,
        )
    if not settings.supabase_url:
        raise RuntimeError("Set SUPABASE_URL or SUPABASE_JWT_SECRET")
    key = _jwks_client(settings.supabase_url).get_signing_key_from_jwt(token)
    return jwt.decode(
        token, key.key, algorithms=["ES256", "RS256"], audience=settings.jwt_audience,
    )


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status.HTTP_401_UNAUTHORIZED, detail=detail, headers={"WWW-Authenticate": "Bearer"},
    )


def current_user(
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> CurrentUser:
    if creds is None:
        raise _unauthorized("missing token")
    try:
        claims = decode_token(creds.credentials, settings)
        return CurrentUser(id=UUID(claims["sub"]), claims=claims)
    except (jwt.PyJWTError, KeyError, ValueError):
        raise _unauthorized("invalid token") from None
