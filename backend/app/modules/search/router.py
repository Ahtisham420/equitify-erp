import uuid

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import or_, select

from app.common import audit
from app.core.deps import DB, Authed
from app.modules.search.global_search import global_search
from app.modules.search.models import SavedView

router = APIRouter(tags=["search"])


class SavedViewIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    module: str = Field(min_length=1, max_length=60)
    params: dict = {}
    visibility: str = Field(default="private", pattern="^(private|team|company)$")
    is_default: bool = False


class SavedViewOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    module: str
    params: dict
    visibility: str
    owner_id: uuid.UUID
    team_id: uuid.UUID | None
    is_default: bool


class SearchHit(BaseModel):
    type: str
    id: uuid.UUID
    title: str
    subtitle: str | None = None
    href: str


@router.get("/search", response_model=list[SearchHit])
async def search(db: DB, user: Authed, q: str = Query(min_length=2, max_length=200), limit: int = Query(20, le=50)):
    """Permission-aware search across the record graph; each source is skipped if the user lacks view access."""
    return await global_search(db, user, q, limit)


@router.get("/saved-views", response_model=list[SavedViewOut])
async def list_views(db: DB, user: Authed, module: str | None = None):
    stmt = select(SavedView).where(
        SavedView.deleted_at.is_(None),
        or_(
            SavedView.owner_id == user.id,
            SavedView.visibility == "company",
            (SavedView.visibility == "team") & (SavedView.team_id == user.user.team_id) & (SavedView.team_id.is_not(None)),
        ),
    )
    if module:
        stmt = stmt.where(SavedView.module == module)
    return list(await db.scalars(stmt.order_by(SavedView.name)))


@router.post("/saved-views", response_model=SavedViewOut, status_code=201)
async def create_view(body: SavedViewIn, db: DB, user: Authed):
    if not user.can(body.module, "view"):
        raise HTTPException(403, "You cannot save views for this module")
    view = SavedView(**body.model_dump(), owner_id=user.id, team_id=user.user.team_id,
                     created_by_id=user.id, updated_by_id=user.id)
    db.add(view)
    await db.flush()
    await audit.record(db, actor=user, action="saved_view.created", entity_type="saved_view", entity_id=view.id,
                       summary=f"{body.module}: {body.name}")
    await db.commit()
    return view


@router.patch("/saved-views/{view_id}", response_model=SavedViewOut)
async def update_view(view_id: uuid.UUID, body: SavedViewIn, db: DB, user: Authed):
    view = await db.get(SavedView, view_id)
    if not view or view.deleted_at:
        raise HTTPException(404, "View not found")
    if view.owner_id != user.id and not user.is_admin:
        raise HTTPException(403, "Only the owner can change this view")
    for k, v in body.model_dump().items():
        setattr(view, k, v)
    view.updated_by_id = user.id
    await db.commit()
    return view


@router.delete("/saved-views/{view_id}", status_code=204)
async def delete_view(view_id: uuid.UUID, db: DB, user: Authed):
    view = await db.get(SavedView, view_id)
    if not view or view.deleted_at:
        raise HTTPException(404, "View not found")
    if view.owner_id != user.id and not user.is_admin:
        raise HTTPException(403, "Only the owner can delete this view")
    await db.delete(view)
    await db.commit()
