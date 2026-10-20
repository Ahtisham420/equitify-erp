from typing import Any, Generic, TypeVar

from fastapi import Query
from pydantic import BaseModel
from sqlalchemy import Select, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute

T = TypeVar("T")


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    page: int
    page_size: int


class ListParams:
    """Common list query params: free-text `q`, pagination and `sort` (`field` or `-field`)."""

    def __init__(
        self,
        q: str | None = Query(None, max_length=200),
        page: int = Query(1, ge=1),
        page_size: int = Query(25, ge=1, le=200),
        sort: str | None = Query(None, max_length=60),
    ):
        self.q = q.strip() if q else None
        self.page = page
        self.page_size = page_size
        self.sort = sort


def apply_search(stmt: Select, q: str | None, columns: list[InstrumentedAttribute]) -> Select:
    """Every whitespace-separated term must match at least one of the columns."""
    if not q:
        return stmt
    for term in q.split():
        stmt = stmt.where(or_(*[col.ilike(f"%{term}%") for col in columns]))
    return stmt


def apply_sort(stmt: Select, sort: str | None, allowed: dict[str, Any], default: Any) -> Select:
    if sort:
        desc = sort.startswith("-")
        col = allowed.get(sort.lstrip("-"))
        if col is not None:
            return stmt.order_by(col.desc().nulls_last() if desc else col.asc().nulls_last())
    return stmt.order_by(default)


def in_filter(stmt: Select, column: Any, values: list[Any] | None) -> Select:
    return stmt.where(column.in_(values)) if values else stmt


def range_filter(stmt: Select, column: Any, low: Any = None, high: Any = None) -> Select:
    if low is not None:
        stmt = stmt.where(column >= low)
    if high is not None:
        stmt = stmt.where(column <= high)
    return stmt


async def paginate(db: AsyncSession, stmt: Select, params: ListParams, *, scalars: bool = True) -> tuple[list, int]:
    total = await db.scalar(select(func.count()).select_from(stmt.order_by(None).subquery()))
    result = await db.execute(stmt.offset((params.page - 1) * params.page_size).limit(params.page_size))
    rows = list(result.scalars().unique().all()) if scalars else list(result.all())
    return rows, int(total or 0)


async def facet_counts(db: AsyncSession, base: Select, column: Any) -> dict[str, int]:
    """Counts per distinct value of `column` within the already-filtered `base` statement."""
    sub = base.order_by(None).subquery()
    col = sub.c[column.key]
    rows = await db.execute(select(col, func.count()).group_by(col))
    return {str(k): int(v) for k, v in rows.all() if k is not None}
