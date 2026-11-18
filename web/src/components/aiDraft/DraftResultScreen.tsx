"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BottomActionBar, BottomActionBarSpacer, Button, Loading, RetryNotice, ScreenHeader, useToast } from "@/components/ui";
import { getEssay, type Essay } from "@/lib/api";
import { regenStyleHref } from "@/lib/newEssayParams";
import { routes } from "@/lib/routes";
import { useOnboardingRedirect } from "@/lib/useOnboardingRedirect";
import { EssayInfoLine, EssayText } from "./EssayView";

/**
 * W330 초안 결과 (?essay={id}, UI 설계서 v7 22쪽)
 * - getEssay의 마지막 버전을 보여 준다 (처음 만든 뒤면 '초안')
 * - 정보 줄 '초안 · 감성적 · 장문 · 1,180자 · 소재 3개' (범위 밖이면 '목표 범위 밖')
 * - [다시 만들기] → W310 다시 만들기 모드 (이 버전 바탕) / [내 서재로] → 글 상세(L120)
 *
 * 새로 들어올 때마다 처음부터 (key = bfcacheId + essay)
 */
export default function DraftResultScreen() {
  const { bfcacheId } = useRouter();
  const essayId = useSearchParams().get("essay") ?? "";
  return <DraftResult key={`${bfcacheId}:${essayId}`} essayId={essayId} />;
}

function DraftResult({ essayId }: { essayId: string }) {
  const router = useRouter();
  const toast = useToast();
  const goOnboardingIfNeeded = useOnboardingRedirect();
  const [essay, setEssay] = useState<Essay | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = essayId
      ? getEssay(essayId)
      : Promise.resolve({ ok: false as const, error: { kind: "not_found" as const, code: "essay_not_found", message: "" } });
    void load.then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setEssay(res.data);
        setFailed(false);
        return;
      }
      if (goOnboardingIfNeeded(res.error)) return;
      if (res.error.code === "essay_not_found") {
        toast("글을 찾을 수 없어요");
        router.replace(routes.library);
        return;
      }
      setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [essayId, attempt, goOnboardingIfNeeded, router, toast]);

  const header = <ScreenHeader title="초안" back />;

  if (failed && !essay) {
    return (
      <>
        {header}
        <div className="px-5 pt-6">
          <RetryNotice message="연결이 불안정해요" onRetry={() => setAttempt((n) => n + 1)} />
        </div>
      </>
    );
  }

  if (!essay) {
    return (
      <>
        {header}
        <Loading fullScreen />
      </>
    );
  }

  const latest = essay.versions[essay.versions.length - 1];
  if (!latest) {
    return (
      <>
        {header}
        <p className="px-5 pt-6 text-sm text-ink-soft">아직 저장된 글이 없어요</p>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="flex flex-col gap-5 px-5 pt-5 pb-4">
        <EssayInfoLine
          lead={latest.label}
          style={latest.style}
          length={latest.length}
          charCount={latest.char_count}
          inLengthRange={latest.in_length_range}
          materialCount={essay.materials.length}
        />
        <EssayText title={latest.title} body={latest.body} />
      </div>

      <BottomActionBarSpacer />
      <BottomActionBar>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" size="lg" onClick={() => router.push(regenStyleHref(routes.newAiStyle, essay.id, { version: latest.id }))}>
            다시 만들기
          </Button>
          <Button size="lg" onClick={() => router.replace(routes.essay(essay.id))}>
            내 서재로
          </Button>
        </div>
      </BottomActionBar>
    </>
  );
}
