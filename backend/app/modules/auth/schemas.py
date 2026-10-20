import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class LoginIn(BaseModel):
    # Plain string: sign-in only looks the address up, and seeded/internal accounts may use reserved domains.
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=1, max_length=200)


class MfaVerifyIn(BaseModel):
    mfa_token: str
    code: str = Field(min_length=6, max_length=8)


class RoleBrief(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    key: str
    name: str


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    full_name: str
    job_title: str | None
    phone: str | None
    role: RoleBrief
    team_id: uuid.UUID | None
    manager_id: uuid.UUID | None
    status: str
    is_service: bool
    mfa_enabled: bool
    last_login_at: datetime | None
    deactivated_at: datetime | None
    created_at: datetime


class MeOut(UserOut):
    permissions: dict[str, list[str]]
    approval_limits: dict


class LoginOut(BaseModel):
    status: str  # ok | mfa_required | mfa_setup
    access_token: str | None = None
    mfa_token: str | None = None
    mfa_secret: str | None = None
    otpauth_url: str | None = None
    user: MeOut | None = None


class UserCreate(BaseModel):
    email: EmailStr
    full_name: str = Field(min_length=1, max_length=200)
    password: str | None = Field(default=None, min_length=8, max_length=200)
    job_title: str | None = None
    phone: str | None = None
    role_id: uuid.UUID
    team_id: uuid.UUID | None = None
    manager_id: uuid.UUID | None = None
    is_service: bool = False


class UserUpdate(BaseModel):
    full_name: str | None = Field(default=None, min_length=1, max_length=200)
    job_title: str | None = None
    phone: str | None = None
    role_id: uuid.UUID | None = None
    team_id: uuid.UUID | None = None
    manager_id: uuid.UUID | None = None
    password: str | None = Field(default=None, min_length=8, max_length=200)


class DeactivateIn(BaseModel):
    reassign_to_id: uuid.UUID | None = None
    reason: str | None = None


class RoleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    key: str
    name: str
    description: str | None
    permissions: dict[str, list[str]]
    approval_limits: dict
    is_system: bool
    user_count: int = 0


class RoleIn(BaseModel):
    key: str = Field(min_length=2, max_length=60, pattern=r"^[a-z0-9_]+$")
    name: str = Field(min_length=1, max_length=120)
    description: str | None = None
    permissions: dict[str, list[str]] = {}
    approval_limits: dict = {}


class RoleUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    permissions: dict[str, list[str]] | None = None
    approval_limits: dict | None = None


class TeamOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    description: str | None
    member_count: int = 0


class TeamIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = None


class CredentialIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    user_id: uuid.UUID
    scopes: list[str] = Field(default_factory=list)


class CredentialOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    user_id: uuid.UUID
    key_prefix: str
    scopes: list[str]
    last_used_at: datetime | None
    revoked_at: datetime | None
    created_at: datetime


class CredentialCreated(CredentialOut):
    api_key: str


class SessionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    created_at: datetime
    expires_at: datetime
    revoked_at: datetime | None
    ip_address: str | None
    user_agent: str | None


class AuditOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    occurred_at: datetime
    actor_id: uuid.UUID | None
    actor_name: str | None
    action: str
    entity_type: str
    entity_id: uuid.UUID | None
    summary: str | None
    changes: dict | None
    ip_address: str | None


class PermissionCatalog(BaseModel):
    modules: dict[str, str]
    actions: list[str]
