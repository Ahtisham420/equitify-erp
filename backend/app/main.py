import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app import registry
from app.core.config import settings
from app.core.database import Base, SessionLocal, engine
from app.core.scheduler import scheduler_loop

logging.basicConfig(level=logging.INFO)

registry.load_models()
registry.load_handlers()


@asynccontextmanager
async def lifespan(_: FastAPI):
    async with engine.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
        await conn.run_sync(Base.metadata.create_all)

    from app.modules.auth.service import seed

    async with SessionLocal() as db:
        await seed(db)

    stop = asyncio.Event()
    scheduler = (
        asyncio.create_task(scheduler_loop(stop)) if getattr(settings, "SCHEDULER_ENABLED", True) else None
    )
    yield
    stop.set()
    if scheduler:
        await scheduler
    await engine.dispose()


app = FastAPI(title=f"{settings.APP_NAME} API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

registry.mount_routers(app, settings.API_PREFIX)


@app.get("/health", tags=["platform"])
async def health():
    return {"status": "ok"}
