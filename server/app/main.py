from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.db import close_pool, open_pool, pool
from app.routers import analysis, essays, events, materials, me, qna, records
from app.usage import DailyLimitError


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

@app.exception_handler(DailyLimitError)
async def daily_limit(_: Request, __: DailyLimitError) -> JSONResponse:
    """R32: '오늘 사용할 수 있는 횟수를 다 썼어요'."""
    return JSONResponse(status_code=429, content={"detail": "daily_limit"})


app.include_router(me.router)
app.include_router(records.router)
app.include_router(qna.router)
app.include_router(analysis.router)
app.include_router(materials.router)
app.include_router(events.router)
app.include_router(essays.router)


@app.get("/health", tags=["health"])
async def health() -> dict:
    async with pool().connection() as conn:
        await conn.execute("select 1")
    return {"status": "ok"}
