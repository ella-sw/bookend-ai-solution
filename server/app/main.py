from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.db import close_pool, open_pool, pool
from app.routers import analysis, events, materials, me, qna, records


@asynccontextmanager
async def lifespan(_: FastAPI):
    await open_pool(get_settings().database_url)
    yield
    await close_pool()


app = FastAPI(title="Rowflow API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origin_list,
    allow_methods=["*"],
    allow_headers=["Authorization", "Content-Type"],
)

app.include_router(me.router)
app.include_router(records.router)
app.include_router(qna.router)
app.include_router(analysis.router)
app.include_router(materials.router)
app.include_router(events.router)


@app.get("/health", tags=["health"])
async def health() -> dict:
    async with pool().connection() as conn:
        await conn.execute("select 1")
    return {"status": "ok"}
