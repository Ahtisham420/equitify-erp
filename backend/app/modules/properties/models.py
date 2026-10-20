from datetime import date

from geoalchemy2 import Geometry
from sqlalchemy import Date, Float, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity
from app.core.database import Base

PROPERTY_STATUSES = ["tracked", "pursued", "rejected", "owned", "managed", "listed", "sold"]
PROPERTY_TYPES = [
    "retail", "stnl", "multi_tenant_retail", "gas_convenience", "medical", "office", "industrial",
    "multifamily", "hospitality", "ground_lease", "land", "mixed_use", "other",
]

# Fields whose changes are historical facts with source/date/confidence/verification.
MATERIAL_FIELDS = {
    "building_area_sf", "land_area_acres", "year_built", "year_renovated", "parking_spaces", "construction_class",
    "asking_price", "last_sale_price", "last_sale_date", "occupancy_pct", "wale_years", "noi",
    "zoning", "future_land_use", "flood_zone", "traffic_count", "property_type",
}


class Property(Entity, Base):
    __tablename__ = "properties"

    # Identity
    name: Mapped[str | None] = mapped_column(String(200))
    address_line: Mapped[str] = mapped_column(String(255))
    city: Mapped[str | None] = mapped_column(String(120), index=True)
    state: Mapped[str | None] = mapped_column(String(40), index=True)
    postal_code: Mapped[str | None] = mapped_column(String(20))
    county: Mapped[str | None] = mapped_column(String(120), index=True)
    normalized_address: Mapped[str] = mapped_column(String(400), index=True)
    alternate_addresses: Mapped[list] = mapped_column(JSONB, default=list)
    latitude: Mapped[float | None] = mapped_column(Float)
    longitude: Mapped[float | None] = mapped_column(Float)
    location = mapped_column(Geometry("POINT", srid=4326, spatial_index=True), nullable=True)

    property_type: Mapped[str] = mapped_column(String(40), index=True, default="other")
    property_subtype: Mapped[str | None] = mapped_column(String(80))
    building_area_sf: Mapped[float | None] = mapped_column(Numeric(14, 2, asdecimal=False))
    land_area_acres: Mapped[float | None] = mapped_column(Numeric(12, 4, asdecimal=False))
    year_built: Mapped[int | None] = mapped_column(Integer)
    year_renovated: Mapped[int | None] = mapped_column(Integer)
    parking_spaces: Mapped[int | None] = mapped_column(Integer)
    construction_class: Mapped[str | None] = mapped_column(String(20))

    status: Mapped[str] = mapped_column(String(20), index=True, default="tracked")

    # Market
    asking_price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    last_sale_price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    last_sale_date: Mapped[date | None] = mapped_column(Date)

    # Income
    occupancy_pct: Mapped[float | None] = mapped_column(Numeric(5, 2, asdecimal=False))
    wale_years: Mapped[float | None] = mapped_column(Numeric(6, 2, asdecimal=False))
    noi: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))

    # Site / location
    zoning: Mapped[str | None] = mapped_column(String(80))
    future_land_use: Mapped[str | None] = mapped_column(String(80))
    flood_zone: Mapped[str | None] = mapped_column(String(20))
    traffic_count: Mapped[int | None] = mapped_column(Integer)
    corridor: Mapped[str | None] = mapped_column(String(160))

    notes: Mapped[str | None] = mapped_column(Text)
    tags: Mapped[list[str]] = mapped_column(ARRAY(String(60)), default=list)
    completeness_score: Mapped[float] = mapped_column(Float, default=0)
