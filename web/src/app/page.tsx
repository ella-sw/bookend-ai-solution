"use client";

import Link from "next/link";
import { useState } from "react";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { Button, ButtonLink } from "@/components/ui/Button";
import { USE_MOCK } from "@/lib/api/config";
import { routes } from "@/lib/routes";

/**
 * H110 홈 (0단계: 최소 화면)
 * - [소재 모으기] → 방식 선택(H120, 아래 시트) → W110 / W210
 * - [새 글 쓰기] → 소재 고르기(N110)
 * - 글쓰기 제안 카드·최근 소재는 실제 데이터 연결 때(6단계) 추가. 지금은 빈 상태만.
 * - 이어 쓰기 확인(H121)은 W110 목업 때 추가
 */
export default function HomePage() {
  const [collectOpen, setCollectOpen] = useState(false);

  return (
    <>
      <header className="flex h-14 items-center px-5">
        <h1 className="text-xl font-extrabold tracking-tight">Rowflow</h1>
      </header>

      <section className="grid grid-cols-2 gap-3 px-5 pt-2">
        <button
          type="button"
          onClick={() => setCollectOpen(true)}
          className="flex h-28 flex-col items-start justify-between rounded-2xl bg-primary p-4 text-left text-white active:brightness-90"
        >
          <span className="text-2xl leading-none">＋</span>
          <span>
            <span className="block text-base font-bold">소재 모으기</span>
            <span className="text-xs opacity-80">떠오른 경험을 적거나 AI 질문에 답해요</span>
          </span>
        </button>
        <Link
          href={routes.newSelect}
          className="flex h-28 flex-col items-start justify-between rounded-2xl border border-line bg-surface p-4 active:bg-subtle"
        >
          <span className="text-2xl leading-none">✎</span>
          <span>
            <span className="block text-base font-bold">새 글 쓰기</span>
            <span className="text-xs text-ink-mute">모인 소재를 골라 글로 엮어요</span>
          </span>
        </Link>
      </section>

      <section className="mt-8 px-5">
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-bold">최근 소재</h2>
          <Link href={routes.materials} className="text-sm text-ink-mute">
            전체 보기
          </Link>
        </div>
        <div className="mt-3 flex flex-col items-center gap-3 rounded-2xl bg-subtle px-5 py-10 text-center">
          <div>
            <p className="text-[15px] font-semibold">아직 모은 소재가 없어요</p>
            <p className="mt-1 text-sm leading-relaxed text-ink-soft">
              오늘 있었던 일 하나를 적어 볼까요?
              <br />
              적은 기록에서 글감을 찾아 드려요.
            </p>
          </div>
          <Button variant="secondary" onClick={() => setCollectOpen(true)}>
            첫 소재 기록하기
          </Button>
        </div>
      </section>

      {/* H120 소재 모으기 방식 선택 */}
      <BottomSheet open={collectOpen} onClose={() => setCollectOpen(false)} title="어떻게 모아볼까요?">
        {({ closeAndGo }) => (
          <div className="flex flex-col gap-2">
            <CollectOption
              title="자유롭게 기록하기"
              description="떠오른 일을 내가 직접 적어요"
              onClick={() => closeAndGo(routes.collectFree)}
            />
            <CollectOption
              title="AI 질문에 답하기"
              description="AI 질문에 답하며 기억을 꺼내요"
              onClick={() => closeAndGo(routes.collectAi)}
            />
          </div>
        )}
      </BottomSheet>

      {(process.env.NODE_ENV !== "production" || USE_MOCK) && (
        <div className="mt-auto px-5 pt-10 pb-4">
          <ButtonLink href="/dev/screens" variant="ghost" block>
            화면 목록 (개발용)
          </ButtonLink>
        </div>
      )}
    </>
  );
}

function CollectOption({ title, description, onClick }: { title: string; description: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center justify-between rounded-2xl border border-line px-4 py-4 text-left active:bg-subtle"
    >
      <span>
        <span className="block text-[15px] font-semibold">{title}</span>
        <span className="text-sm text-ink-mute">{description}</span>
      </span>
      <span aria-hidden className="text-ink-mute">
        ›
      </span>
    </button>
  );
}
