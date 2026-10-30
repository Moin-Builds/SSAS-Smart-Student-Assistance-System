"""
Authentication & Authorization for SSAS AI Backend.
Verifies Supabase JWT tokens and extracts verified student identity.
"""

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from supabase import create_client, Client
from backend.app.config import settings

security = HTTPBearer()

# Shared Supabase admin client using SERVICE_ROLE_KEY
supabase_admin: Client = create_client(
    settings.SUPABASE_URL,
    settings.SUPABASE_SERVICE_ROLE_KEY
)


def get_current_student(credentials: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    """
    Validates the bearer token against Supabase Auth.
    Returns the authenticated student dictionary containing 'id', 'email', etc.
    Raises HTTPException(401) if invalid or expired.
    """
    token = credentials.credentials
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing authentication credentials"
        )

    try:
        # Verify token cryptographically with Supabase Auth
        user_response = supabase_admin.auth.get_user(token)
        if not user_response or not user_response.user:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or expired session token"
            )
        
        user = user_response.user
        return {
            "id": str(user.id),
            "email": user.email,
            "raw_user": user
        }
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Authentication failed: {str(e)}"
        )
