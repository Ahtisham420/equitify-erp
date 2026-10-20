import uuid
from datetime import timedelta

import jwt
from fastapi import HTTPException, status
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit
from app.core import events
from app.core.config import settings
from app.core.deps import CurrentUser
from app.core.security import (
    create_token,
    decode_token,
    hash_password,
    new_api_key,
    new_totp_secret,
    totp_uri,
    utcnow,
    verify_password,
    verify_totp,
)
from app.modules.auth.models import Role, ServiceCredential, Team, User, UserSession
from app.modules.auth.permissions import DEFAULT_ROLES
from app.modules.auth.schemas import (
    CredentialIn,
    DeactivateIn,
    LoginOut,
    MeOut,
    RoleIn,
    RoleUpdate,
    UserCreate,
    UserUpdate,
)


def me_out(user: User) -> MeOut:
    return MeOut.model_validate(
        {
            **{k: getattr(user, k) for k in MeOut.model_fields if k not in ("permissions", "approval_limits")},
            "permissions": user.role.permissions or {},
            "approval_limits": user.role.approval_limits or {},
        },
        from_attributes=True,
    )


# --- Authentication -------------------------------------------------------------------------

async def login(db: AsyncSession, email: str, password: str, ip: str | None, agent: str | None) -> LoginOut:
    user = await db.scalar(select(User).where(func.lower(User.email) == email.lower(), User.deleted_at.is_(None)))
    if not user or user.is_service or not verify_password(password, user.password_hash):
        await audit.record(db, actor=user, action="auth.login_failed", entity_type="user",
                           entity_id=user.id if user else None, summary=email, ip_address=ip)
        await db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid email or password")
    if user.status != "active":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This account is deactivated")

    if not settings.MFA_ENFORCED:
        token = await _start_session(db, user, ip, agent)
        return LoginOut(status="ok", access_token=token, user=me_out(user))

    mfa_token = create_token(user.id, "mfa", settings.MFA_TOKEN_MINUTES)
    if user.mfa_enabled:
        return LoginOut(status="mfa_required", mfa_token=mfa_token)

    if not user.mfa_secret:
        user.mfa_secret = new_totp_secret()
        await db.commit()
    return LoginOut(
        status="mfa_setup", mfa_token=mfa_token, mfa_secret=user.mfa_secret,
        otpauth_url=totp_uri(user.mfa_secret, user.email),
    )


async def verify_mfa(db: AsyncSession, mfa_token: str, code: str, ip: str | None, agent: str | None) -> LoginOut:
    try:
        payload = decode_token(mfa_token)
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Verification expired, sign in again")
    if payload.get("purpose") != "mfa":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid verification token")
    user = await db.get(User, uuid.UUID(payload["sub"]))
    if not user or user.status != "active" or not user.mfa_secret:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid verification token")
    if not verify_totp(user.mfa_secret, code):
        await audit.record(db, actor=user, action="auth.mfa_failed", entity_type="user", entity_id=user.id, ip_address=ip)
        await db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Incorrect code")
    if not user.mfa_enabled:
        user.mfa_enabled = True
        await audit.record(db, actor=user, action="auth.mfa_enrolled", entity_type="user", entity_id=user.id, ip_address=ip)
    token = await _start_session(db, user, ip, agent)
    return LoginOut(status="ok", access_token=token, user=me_out(user))


async def _start_session(db: AsyncSession, user: User, ip: str | None, agent: str | None) -> str:
    session = UserSession(
        user_id=user.id,
        expires_at=utcnow() + timedelta(minutes=settings.ACCESS_TOKEN_MINUTES),
        ip_address=ip,
        user_agent=(agent or "")[:400],
    )
    db.add(session)
    user.last_login_at = utcnow()
    await db.flush()
    await audit.record(db, actor=user, action="auth.login", entity_type="user", entity_id=user.id, ip_address=ip)
    await db.commit()
    return create_token(user.id, "access", settings.ACCESS_TOKEN_MINUTES, session_id=session.id)


async def logout(db: AsyncSession, current: CurrentUser) -> None:
    if current.session_id:
        session = await db.get(UserSession, current.session_id)
        if session and not session.revoked_at:
            session.revoked_at = utcnow()
    await audit.record(db, actor=current, action="auth.logout", entity_type="user", entity_id=current.id,
                       ip_address=current.ip_address)
    await db.commit()


async def revoke_all_sessions(db: AsyncSession, user_id: uuid.UUID) -> None:
    await db.execute(
        update(UserSession)
        .where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None))
        .values(revoked_at=utcnow())
    )


# --- Users ----------------------------------------------------------------------------------

async def get_user(db: AsyncSession, user_id: uuid.UUID) -> User:
    user = await db.get(User, user_id, populate_existing=True)
    if not user or user.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    return user


async def create_user(db: AsyncSession, data: UserCreate, actor: CurrentUser) -> User:
    exists = await db.scalar(select(User.id).where(func.lower(User.email) == data.email.lower()))
    if exists:
        raise HTTPException(status.HTTP_409_CONFLICT, "A user with this email already exists")
    if not await db.get(Role, data.role_id):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Role not found")
    if not data.is_service and not data.password:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Password is required for human users")
    user = User(
        **data.model_dump(exclude={"password", "email"}),
        email=data.email.lower(),
        password_hash=hash_password(data.password) if data.password else None,
        created_by_id=actor.id,
        updated_by_id=actor.id,
    )
    db.add(user)
    await db.flush()
    await audit.record(db, actor=actor, action="user.created", entity_type="user", entity_id=user.id,
                       summary=f"{user.full_name} <{user.email}>", ip_address=actor.ip_address)
    await db.commit()
    return await get_user(db, user.id)


async def update_user(db: AsyncSession, user: User, data: UserUpdate, actor: CurrentUser) -> User:
    values = data.model_dump(exclude_unset=True, exclude={"password"})
    changes = audit.diff(user, values)
    for k, v in values.items():
        setattr(user, k, v)
    if data.password:
        user.password_hash = hash_password(data.password)
        changes["password"] = {"from": "***", "to": "***"}
        await revoke_all_sessions(db, user.id)
    user.updated_by_id = actor.id
    if changes:
        action = "user.permissions_changed" if "role_id" in changes else "user.updated"
        await audit.record(db, actor=actor, action=action, entity_type="user", entity_id=user.id,
                           changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return await get_user(db, user.id)


async def deactivate_user(db: AsyncSession, user: User, data: DeactivateIn, actor: CurrentUser) -> User:
    if user.id == actor.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "You cannot deactivate your own account")
    if data.reassign_to_id:
        target = await get_user(db, data.reassign_to_id)
        if target.status != "active":
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Reassignment target is not active")
    user.status = "inactive"
    user.deactivated_at = utcnow()
    user.updated_by_id = actor.id
    await revoke_all_sessions(db, user.id)
    await db.execute(
        update(ServiceCredential)
        .where(ServiceCredential.user_id == user.id, ServiceCredential.revoked_at.is_(None))
        .values(revoked_at=utcnow())
    )
    # Modules that own records (opportunities, tasks, territories...) reassign on this event.
    await events.emit(db, "user.deactivated", user_id=user.id, reassign_to_id=data.reassign_to_id, actor=actor)
    await audit.record(db, actor=actor, action="user.deactivated", entity_type="user", entity_id=user.id,
                       summary=data.reason, changes={"reassigned_to": str(data.reassign_to_id) if data.reassign_to_id else None},
                       ip_address=actor.ip_address)
    await db.commit()
    return await get_user(db, user.id)


async def reactivate_user(db: AsyncSession, user: User, actor: CurrentUser) -> User:
    user.status = "active"
    user.deactivated_at = None
    user.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="user.reactivated", entity_type="user", entity_id=user.id,
                       ip_address=actor.ip_address)
    await db.commit()
    return await get_user(db, user.id)


async def reset_mfa(db: AsyncSession, user: User, actor: CurrentUser) -> None:
    user.mfa_enabled = False
    user.mfa_secret = None
    await revoke_all_sessions(db, user.id)
    await audit.record(db, actor=actor, action="user.mfa_reset", entity_type="user", entity_id=user.id,
                       ip_address=actor.ip_address)
    await db.commit()


# --- Roles & teams --------------------------------------------------------------------------

async def create_role(db: AsyncSession, data: RoleIn, actor: CurrentUser) -> Role:
    if await db.scalar(select(Role.id).where(Role.key == data.key)):
        raise HTTPException(status.HTTP_409_CONFLICT, "Role key already exists")
    role = Role(**data.model_dump(), created_by_id=actor.id, updated_by_id=actor.id)
    db.add(role)
    await db.flush()
    await audit.record(db, actor=actor, action="role.created", entity_type="role", entity_id=role.id,
                       summary=role.name, changes={"permissions": data.permissions}, ip_address=actor.ip_address)
    await db.commit()
    return role


async def update_role(db: AsyncSession, role: Role, data: RoleUpdate, actor: CurrentUser) -> Role:
    values = data.model_dump(exclude_unset=True)
    if role.key == "admin" and "permissions" in values:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Admin permissions cannot be changed")
    changes = audit.diff(role, values)
    for k, v in values.items():
        setattr(role, k, v)
    role.updated_by_id = actor.id
    if changes:
        await audit.record(db, actor=actor, action="role.permissions_changed", entity_type="role", entity_id=role.id,
                           summary=role.name, changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return role


async def role_user_counts(db: AsyncSession) -> dict[uuid.UUID, int]:
    rows = await db.execute(select(User.role_id, func.count()).where(User.deleted_at.is_(None)).group_by(User.role_id))
    return {r: c for r, c in rows.all()}


async def team_member_counts(db: AsyncSession) -> dict[uuid.UUID, int]:
    rows = await db.execute(
        select(User.team_id, func.count()).where(User.deleted_at.is_(None), User.team_id.is_not(None)).group_by(User.team_id)
    )
    return {t: c for t, c in rows.all()}


async def create_team(db: AsyncSession, name: str, description: str | None, actor: CurrentUser) -> Team:
    team = Team(name=name, description=description, created_by_id=actor.id, updated_by_id=actor.id)
    db.add(team)
    await db.flush()
    await audit.record(db, actor=actor, action="team.created", entity_type="team", entity_id=team.id, summary=name)
    await db.commit()
    return team


# --- Service credentials ----------------------------------------------------------------------

async def create_credential(db: AsyncSession, data: CredentialIn, actor: CurrentUser) -> tuple[ServiceCredential, str]:
    user = await get_user(db, data.user_id)
    if not user.is_service:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Credentials can only be issued to service users")
    plain, prefix, key_hash = new_api_key()
    cred = ServiceCredential(name=data.name, user_id=user.id, key_prefix=prefix, key_hash=key_hash,
                             scopes=data.scopes, created_by_id=actor.id, updated_by_id=actor.id)
    db.add(cred)
    await db.flush()
    await audit.record(db, actor=actor, action="credential.created", entity_type="service_credential",
                       entity_id=cred.id, summary=data.name, changes={"scopes": data.scopes}, ip_address=actor.ip_address)
    await db.commit()
    return cred, plain


async def revoke_credential(db: AsyncSession, cred: ServiceCredential, actor: CurrentUser) -> ServiceCredential:
    cred.revoked_at = utcnow()
    await audit.record(db, actor=actor, action="credential.revoked", entity_type="service_credential",
                       entity_id=cred.id, summary=cred.name, ip_address=actor.ip_address)
    await db.commit()
    return cred


# --- Seed -----------------------------------------------------------------------------------

async def seed(db: AsyncSession) -> None:
    existing = {r.key: r for r in await db.scalars(select(Role))}
    for spec in DEFAULT_ROLES:
        if spec["key"] not in existing:
            role = Role(**spec, is_system=True)
            db.add(role)
            existing[spec["key"]] = role
    await db.flush()
    if not await db.scalar(select(func.count()).select_from(User)):
        db.add(User(
            email=settings.SEED_ADMIN_EMAIL.lower(),
            full_name="System Administrator",
            password_hash=hash_password(settings.SEED_ADMIN_PASSWORD),
            job_title="Administrator",
            role_id=existing["admin"].id,
        ))
    await db.commit()
