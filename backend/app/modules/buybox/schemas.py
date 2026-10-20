import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Operator = Literal["eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte", "between", "contains", "is_set"]
Requirement = Literal["mandatory", "preferred", "disqualifying"]
Result = Literal["pass", "pass_with_exception", "fail", "insufficient_data"]


class CriterionIn(BaseModel):
    field: str = Field(min_length=1, max_length=60)
    operator: Operator
    value: Any = None
    requirement: Requirement = "mandatory"
    note: str | None = Field(default=None, max_length=300)

    @model_validator(mode="after")
    def _check_value(self):
        op, v = self.operator, self.value
        if op in ("in", "not_in") and not (isinstance(v, list) and v):
            raise ValueError(f"'{op}' needs a non-empty list of values")
        if op == "between" and not (isinstance(v, list) and len(v) == 2 and all(x not in (None, "") for x in v)):
            raise ValueError("'between' needs [min, max]")
        if op == "is_set":
            self.value = True if v is None else bool(v)
        elif op not in ("in", "not_in", "between") and v in (None, "", []):
            raise ValueError(f"'{op}' needs a value")
        return self


class CriterionOut(CriterionIn):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    position: int


class CriteriaReplace(BaseModel):
    criteria: list[CriterionIn] = Field(max_length=100)
    change_note: str | None = None


class BuyBoxBase(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: str | None = None
    strategy: str = Field(default="other", min_length=1, max_length=60)
    owner_id: uuid.UUID | None = None
    active_from: date | None = None
    active_to: date | None = None
    is_active: bool = True

    @model_validator(mode="after")
    def _dates(self):
        if self.active_from and self.active_to and self.active_to < self.active_from:
            raise ValueError("active_to must be on or after active_from")
        return self


class BuyBoxCreate(BuyBoxBase):
    criteria: list[CriterionIn] = Field(default=[], max_length=100)


class BuyBoxUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = None
    strategy: str | None = Field(default=None, min_length=1, max_length=60)
    owner_id: uuid.UUID | None = None
    active_from: date | None = None
    active_to: date | None = None
    is_active: bool | None = None


class BuyBoxListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    strategy: str
    owner_id: uuid.UUID | None
    owner_name: str | None = None
    active_from: date | None
    active_to: date | None
    is_active: bool
    version: int
    criteria_count: int = 0
    result_counts: dict[str, int] = {}
    updated_at: datetime


class BuyBoxOut(BuyBoxListItem):
    description: str | None
    criteria: list[CriterionOut] = []
    created_at: datetime


class VersionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    version: int
    criteria: list[dict]
    change_note: str | None
    created_at: datetime
    created_by_id: uuid.UUID | None
    created_by_name: str | None = None


class EvaluationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    property_id: uuid.UUID
    property_label: str | None = None
    property_city: str | None = None
    property_state: str | None = None
    buy_box_id: uuid.UUID
    buy_box_name: str | None = None
    buy_box_version: int
    result: str
    raw_result: str
    missing_fields: list[str]
    details: list[dict]
    preferred_misses: list[dict]
    evaluated_at: datetime
    is_current: bool
    trigger: str
    exception_status: str
    exception_requested_by_id: uuid.UUID | None
    exception_requested_by_name: str | None = None
    exception_requested_at: datetime | None
    exception_request_reason: str | None
    exception_approver_id: uuid.UUID | None
    exception_approver_name: str | None = None
    exception_decided_at: datetime | None
    exception_decision_reason: str | None


class BuyBoxFacets(BaseModel):
    strategy: dict[str, int]
    is_active: dict[str, int]
    result: dict[str, int]


class EvaluateAllOut(BaseModel):
    evaluated: int
    changed: int
    unchanged: int
    by_result: dict[str, int]


class ExceptionRequestIn(BaseModel):
    reason: str = Field(min_length=3, max_length=2000)


class ExceptionDecisionIn(BaseModel):
    approve: bool
    reason: str = Field(min_length=3, max_length=2000)
