"""Verify Firebase Authentication ID tokens sent by the frontend.

Enabled when FIREBASE_PROJECT_ID is set. Tokens are RS256 JWTs signed by Google's
securetoken service; see https://firebase.google.com/docs/auth/admin/verify-id-tokens.
"""

import os

import jwt

JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
_jwks: jwt.PyJWKClient | None = None


class AuthError(Exception):
    pass


def project_id() -> str:
    return os.getenv("FIREBASE_PROJECT_ID", "").strip()


def enabled() -> bool:
    return bool(project_id())


def _signing_key(token: str):
    global _jwks
    if _jwks is None:
        # Google rotates these keys; PyJWKClient caches them and refetches unknown key IDs.
        _jwks = jwt.PyJWKClient(JWKS_URL, cache_keys=True, lifespan=3600, timeout=5)
    return _jwks.get_signing_key_from_jwt(token).key


def verify(header: str | None) -> dict:
    """Return the token's claims, or raise AuthError with a user-facing reason."""
    if not header or not header.startswith("Bearer "):
        raise AuthError("Sign in to use this feature.")
    token = header.removeprefix("Bearer ").strip()
    pid = project_id()
    try:
        claims = jwt.decode(
            token,
            _signing_key(token),
            algorithms=["RS256"],
            audience=pid,
            issuer=f"https://securetoken.google.com/{pid}",
            options={"require": ["exp", "iat", "sub", "aud", "iss"]},
            leeway=30,
        )
    except jwt.ExpiredSignatureError as e:
        raise AuthError("Your sign-in expired. Refresh the page and try again.") from e
    except (jwt.PyJWTError, ValueError) as e:
        raise AuthError("Your sign-in couldn't be verified. Log in again.") from e
    if not claims.get("sub"):
        raise AuthError("Your sign-in couldn't be verified. Log in again.")
    return claims
