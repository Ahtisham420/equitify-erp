import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select

from app.common import audit
from app.common.audit import AuditEvent
from app.common.query import ListParams, Page, apply_search, apply_sort, in_filter, paginate, range_filter
from app.core.deps import DB, Authed, CurrentUser, require
from app.modules.auth import service
from app.modules.auth.models import Role, ServiceCredential, Team, User, UserSession
from app.modules.auth.permissions import ACTIONS, MODULES
from app.modules.auth.schemas import (
    AuditOut,
    CredentialCreated,
    CredentialIn,
    CredentialOut,
    DeactivateIn,
    LoginIn,
    LoginOut,
    MeOut,
    MfaVerifyIn,
    PermissionCatalog,
    RoleIn,
    RoleOut,
    RoleUpdate,
    SessionOut,
    TeamIn,
    TeamOut,
    UserCreate,
    UserOut,
    UserUpdate,
)

router = APIRouter()


def _client(request: Request) -> tuple[str | None, str | None]:
    return (request.client.host if request.client else None, request.headers.get("user-agent"))


# --- Auth -----------------------------------------------------------------------------------

@router.post("/auth/login", response_model=LoginOut, tags=["auth"])
async def login(body: LoginIn, request: Request, db: DB):
    return await service.login(db, body.email, body.password, *_client(request))


@router.post("/auth/mfa/verify", response_model=LoginOut, tags=["auth"])
async def verify_mfa(body: MfaVerifyIn, request: Request, db: DB):
    return await service.verify_mfa(db, body.mfa_token, body.code, *_client(request))


@router.post("/auth/logout", status_code=204, tags=["auth"])
async def logout(user: Authed, db: DB):
    await service.logout(db, user)


@router.get("/auth/me", response_model=MeOut, tags=["auth"])
async def me(user: Authed):
    return service.me_out(user.user)


@router.get("/auth/permissions", response_model=PermissionCatalog, tags=["auth"])
async def permission_catalog(_: Authed):
    return PermissionCatalog(modules=MODULES, actions=ACTIONS)


# --- Users ----------------------------------------------------------------------------------

@router.get("/users", response_model=Page[UserOut], tags=["users"])
async def list_users(
    db: DB,
    params: ListParams = Depends(),
    role_id: list[uuid.UUID] | None = Query(None),
    team_id: list[uuid.UUID] | None = Query(None),
    status: list[str] | None = Query(None),
    is_service: bool | None = None,
    _: CurrentUser = Depends(require("users", "view")),
):
    stmt = select(User).where(User.deleted_at.is_(None))
    stmt = apply_search(stmt, params.q, [User.full_name, User.email, User.job_title])
    stmt = in_filter(stmt, User.role_id, role_id)
    stmt = in_filter(stmt, User.team_id, team_id)
    stmt = in_filter(stmt, User.status, status)
    if is_service is not None:
        stmt = stmt.where(User.is_service.is_(is_service))
    stmt = apply_sort(stmt, params.sort, {
        "full_name": User.full_name, "email": User.email, "status": User.status,
        "last_login_at": User.last_login_at, "created_at": User.created_at,
    }, User.full_name.asc())
    items, total = await paginate(db, stmt, params)
    return Page[UserOut](items=items, total=total, page=params.page, page_size=params.page_size)


@router.get("/users/options", response_model=list[UserOut], tags=["users"])
async def user_options(db: DB, _: Authed):
    """Lightweight list of active users for owner/assignee pickers."""
    rows = await db.scalars(
        select(User).where(User.deleted_at.is_(None), User.status == "active", User.is_service.is_(False))
        .order_by(User.full_name)
    )
    return list(rows)


@router.post("/users", response_model=UserOut, status_code=201, tags=["users"])
async def create_user(body: UserCreate, db: DB, user: CurrentUser = Depends(require("users", "create"))):
    return await service.create_user(db, body, user)


@router.get("/users/{user_id}", response_model=UserOut, tags=["users"])
async def get_user(user_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("users", "view"))):
    return await service.get_user(db, user_id)


@router.patch("/users/{user_id}", response_model=UserOut, tags=["users"])
async def update_user(user_id: uuid.UUID, body: UserUpdate, db: DB, user: CurrentUser = Depends(require("users", "edit"))):
    return await service.update_user(db, await service.get_user(db, user_id), body, user)


@router.post("/users/{user_id}/deactivate", response_model=UserOut, tags=["users"])
async def deactivate_user(user_id: uuid.UUID, body: DeactivateIn, db: DB,
                          user: CurrentUser = Depends(require("users", "edit"))):
    return await service.deactivate_user(db, await service.get_user(db, user_id), body, user)


@router.post("/users/{user_id}/reactivate", response_model=UserOut, tags=["users"])
async def reactivate_user(user_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("users", "edit"))):
    return await service.reactivate_user(db, await service.get_user(db, user_id), user)


@router.post("/users/{user_id}/reset-mfa", status_code=204, tags=["users"])
async def reset_mfa(user_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("users", "edit"))):
    await service.reset_mfa(db, await service.get_user(db, user_id), user)


@router.get("/users/{user_id}/sessions", response_model=list[SessionOut], tags=["users"])
async def user_sessions(user_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("users", "view"))):
    rows = await db.scalars(
        select(UserSession).where(UserSession.user_id == user_id).order_by(UserSession.created_at.desc()).limit(50)
    )
    return list(rows)


# --- Roles & teams --------------------------------------------------------------------------

@router.get("/roles", response_model=list[RoleOut], tags=["roles"])
async def list_roles(db: DB, _: Authed):
    counts = await service.role_user_counts(db)
    roles = await db.scalars(select(Role).where(Role.deleted_at.is_(None)).order_by(Role.name))
    return [RoleOut.model_validate(r).model_copy(update={"user_count": counts.get(r.id, 0)}) for r in roles]


@router.post("/roles", response_model=RoleOut, status_code=201, tags=["roles"])
async def create_role(body: RoleIn, db: DB, user: CurrentUser = Depends(require("users", "approve"))):
    return await service.create_role(db, body, user)


@router.patch("/roles/{role_id}", response_model=RoleOut, tags=["roles"])
async def update_role(role_id: uuid.UUID, body: RoleUpdate, db: DB,
                      user: CurrentUser = Depends(require("users", "approve"))):
    role = await db.get(Role, role_id)
    if not role:
        raise HTTPException(404, "Role not found")
    return await service.update_role(db, role, body, user)


@router.get("/teams", response_model=list[TeamOut], tags=["teams"])
async def list_teams(db: DB, _: Authed):
    counts = await service.team_member_counts(db)
    teams = await db.scalars(select(Team).where(Team.deleted_at.is_(None)).order_by(Team.name))
    return [TeamOut.model_validate(t).model_copy(update={"member_count": counts.get(t.id, 0)}) for t in teams]


@router.post("/teams", response_model=TeamOut, status_code=201, tags=["teams"])
async def create_team(body: TeamIn, db: DB, user: CurrentUser = Depends(require("users", "create"))):
    return await service.create_team(db, body.name, body.description, user)


# --- Service credentials ----------------------------------------------------------------------

@router.get("/service-credentials", response_model=list[CredentialOut], tags=["users"])
async def list_credentials(db: DB, _: CurrentUser = Depends(require("users", "view"))):
    return list(await db.scalars(select(ServiceCredential).order_by(ServiceCredential.created_at.desc())))


@router.post("/service-credentials", response_model=CredentialCreated, status_code=201, tags=["users"])
async def create_credential(body: CredentialIn, db: DB, user: CurrentUser = Depends(require("users", "approve"))):
    cred, plain = await service.create_credential(db, body, user)
    return CredentialCreated.model_validate({**CredentialOut.model_validate(cred).model_dump(), "api_key": plain})


@router.post("/service-credentials/{cred_id}/revoke", response_model=CredentialOut, tags=["users"])
async def revoke_credential(cred_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("users", "approve"))):
    cred = await db.get(ServiceCredential, cred_id)
    if not cred:
        raise HTTPException(404, "Credential not found")
    return await service.revoke_credential(db, cred, user)


# --- Audit ----------------------------------------------------------------------------------

@router.get("/audit", response_model=Page[AuditOut], tags=["audit"])
async def list_audit(
    db: DB,
    params: ListParams = Depends(),
    entity_type: list[str] | None = Query(None),
    entity_id: uuid.UUID | None = None,
    actor_id: uuid.UUID | None = None,
    action: list[str] | None = Query(None),
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    user: CurrentUser = Depends(require("audit", "view")),
):
    stmt = select(AuditEvent)
    stmt = apply_search(stmt, params.q, [AuditEvent.summary, AuditEvent.action, AuditEvent.actor_name])
    stmt = in_filter(stmt, AuditEvent.entity_type, entity_type)
    stmt = in_filter(stmt, AuditEvent.action, action)
    if entity_id:
        stmt = stmt.where(AuditEvent.entity_id == entity_id)
    if actor_id:
        stmt = stmt.where(AuditEvent.actor_id == actor_id)
    stmt = range_filter(stmt, AuditEvent.occurred_at, date_from, date_to)
    stmt = apply_sort(stmt, params.sort, {"occurred_at": AuditEvent.occurred_at, "action": AuditEvent.action},
                      AuditEvent.occurred_at.desc())
    items, total = await paginate(db, stmt, params)
    return Page[AuditOut](items=items, total=total, page=params.page, page_size=params.page_size)


@router.get("/timeline/{entity_type}/{entity_id}", response_model=list[AuditOut], tags=["audit"])
async def record_timeline(entity_type: str, entity_id: uuid.UUID, db: DB, _: Authed, limit: int = Query(100, le=500)):
    """Change history shown on any record page. Viewing a record already required module permission."""
    rows = await db.scalars(
        select(AuditEvent)
        .where(AuditEvent.entity_type == entity_type, AuditEvent.entity_id == entity_id)
        .order_by(AuditEvent.occurred_at.desc())
        .limit(limit)
    )
    return list(rows)
