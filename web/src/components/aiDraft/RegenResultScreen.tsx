"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BottomActionBar, BottomActionBarSpacer, Button, Loading, ScreenHeader, useBackToClose, useToast } from "@/components/ui";
import { Overlay } from "@/components/ui/Overlay";
import { getEssay, newSaveToken, saveRegeneration, type RegenResult } from "@/lib/api";
import { regenStyleHref } from "@/lib/newEssayParams";
import { getRegenResult, removeRegenResult } from "@/lib/regenResultStore";
import { routes } from "@/lib/routes";
import { useOnboardingRedirect } from "@/lib/useOnboardingRedirect";
import { EssayInfoLine, EssayText } from "./EssayView";

/**
 * W340 다시 만든 결과 + W341 저장 창 (?essay=&request=, UI 설계서 v7 23쪽, 목록 28번)
 * - 결과는 W310에서 sessionStorage(regen:{essayId}:{request_id})에 넣어 둔 것 → 새로고침해도 남음.
 *   없으면 '저장하지 않은 결과는 사라졌어요' + [글 보기]
 * - 정보 줄 '다시 만들기 N회째 · 담백함 · 장문 · 1,240자' (범위 밖이면 '목표 범위 밖')
 * - 삭제한 소재를 빼고 만들었으면 안내
 * - [다시 만들기] → W310 다시 만들기 모드 (이 결과 바탕) / [저장] → W341
 *
 * 새로 들어올 때마다 처음부터 (key = bfcacheId + 주소 검색값)
 */
export default function RegenResultScreen() {
  const { bfcacheId } = useRouter();
  const query = useSearchParams().toString();
  const target = useMemo(() => {
    const q = new URLSearchParams(query);
    return { essayId: q.get("essay") ?? "", requestId: Number(q.get("request")) };
  }, [query]);
  return <RegenResultView key={`${bfcacheId}:${query}`} essayId={target.essayId} requestId={target.requestId} />;
}

function RegenResultView({ essayId, requestId }: { essayId: string; requestId: number }) {
  const router = useRouter();
  // 이 탭에 남겨 둔 결과 (서버는 저장 안 한 결과를 다시 돌려주지 않음).
  // sessionStorage는 브라우저에만 있으므로 화면을 띄운 뒤 읽는다 (서버에서 먼저 그릴 때와 어긋나지 않게)
  const [result, setResult] = useState<RegenResult | null | undefined>(undefined);
  const [saveOpen, setSaveOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setResult(essayId && Number.isInteger(requestId) && requestId > 0 ? getRegenResult(essayId, requestId) : null);
    });
    return () => {
      cancelled = true;
    };
  }, [essayId, requestId]);

  if (result === undefined) {
    return (
      <>
        <ScreenHeader title="다시 만든 글" back />
        <Loading fullScreen />
      </>
    );
  }

  if (!result) {
    return (
      <>
        <ScreenHeader title="다시 만든 글" back />
        <section className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <p className="text-[15px] font-semibold">저장하지 않은 결과는 사라졌어요</p>
          {essayId && (
            <Button variant="secondary" onClick={() => router.replace(routes.essay(essayId))}>
              글 보기
            </Button>
          )}
        </section>
      </>
    );
  }

  return (
    <>
      <ScreenHeader title="다시 만든 글" back />
      <div className="flex flex-col gap-5 px-5 pt-5 pb-4">
        <EssayInfoLine
          lead={`다시 만들기 ${result.regen_count}회째`}
          style={result.style}
          length={result.length}
          charCount={result.char_count}
          inLengthRange={result.in_length_range}
        />
        {result.deleted_materials_left_out && (
          <p className="rounded-xl bg-subtle px-4 py-3 text-sm leading-relaxed text-ink-soft">
            삭제한 소재는 새로 넣지 않아요. 지금 글에 있는 내용은 그대로 바탕이 돼요.
          </p>
        )}
        <EssayText title={result.title} body={result.body} />
        <p className="text-sm text-ink-mute">저장하지 않으면 이 결과는 사라져요.</p>
      </div>

      <BottomActionBarSpacer />
      <BottomActionBar>
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="secondary"
            size="lg"
            onClick={() => router.push(regenStyleHref(routes.newAiStyle, result.essay_id, { request: result.request_id }))}
          >
            다시 만들기
          </Button>
          <Button size="lg" onClick={() => setSaveOpen(true)}>
            저장
          </Button>
        </div>
      </BottomActionBar>

      {saveOpen && <SaveVersionDialog result={result} onClose={() => setSaveOpen(false)} />}
    </>
  );
}

/**
 * W341 저장 창: 'v{N}로 저장할까요?' (N = 지금 버전 중 가장 큰 번호 + 1, 초안만 있으면 v1)
 * - save_token은 창을 열 때 하나, [다시 시도]에도 같은 값 (두 번 눌러도 버전은 하나)
 * - 성공 → 결과 지우고 L120 (이 창이 닫힌 뒤 W340 자리를 L120으로 바꾼다)
 * - 실패 → 창에 '저장하지 못했어요' + [다시 시도], 결과 유지. 409 no_result → 토스트 + 글 보기
 */
function SaveVersionDialog({ result, onClose }: { result: RegenResult; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const goOnboardingIfNeeded = useOnboardingRedirect();
  const titleId = useId();
  const [nextNo, setNextNo] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [saveToken] = useState(newSaveToken);
  const busy = useRef(false);
  /** 창이 닫힌 뒤 갈 곳 */
  const goAfterClose = useRef<string | null>(null);

  const { close } = useBackToClose(true, () => {
    onClose();
    if (goAfterClose.current) router.replace(goAfterClose.current);
  });

  // 새 버전 번호: 지금 버전 중 가장 큰 번호 + 1
  useEffect(() => {
    let cancelled = false;
    void getEssay(result.essay_id).then((res) => {
      if (!cancelled && res.ok) setNextNo(Math.max(0, ...res.data.versions.map((v) => v.version_no)) + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [result.essay_id]);

  const save = async () => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setFailed(false);
    const res = await saveRegeneration(result.essay_id, result.request_id, { save_token: saveToken });
    busy.current = false;
    setSaving(false);
    if (res.ok) {
      removeRegenResult(result.essay_id, result.request_id);
      goAfterClose.current = routes.essay(res.data.id);
      close();
      return;
    }
    if (goOnboardingIfNeeded(res.error)) return;
    if (res.error.code === "no_result") {
      removeRegenResult(result.essay_id, result.request_id);
      toast("이미 저장했거나 결과가 사라졌어요");
      goAfterClose.current = routes.essay(result.essay_id);
      close();
      return;
    }
    setFailed(true);
  };

  return (
    <Overlay align="center" onBackdropClick={saving ? undefined : close}>
      <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} className="w-full max-w-sm rounded-2xl bg-surface p-5 shadow-xl">
        <h2 id={titleId} className="text-[17px] font-bold leading-snug">
          {nextNo !== null ? `v${nextNo}로 저장할까요?` : "새 버전으로 저장할까요?"}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">지금 보이는 글이 새 버전으로 저장돼요.</p>
        {failed && <p className="mt-3 text-sm text-danger">저장하지 못했어요</p>}
        <div className="mt-5 grid grid-cols-2 gap-2">
          <Button variant="secondary" block disabled={saving} onClick={close}>
            취소
          </Button>
          <Button variant="primary" block loading={saving} onClick={() => void save()}>
            {failed ? "다시 시도" : "저장하기"}
          </Button>
        </div>
      </div>
    </Overlay>
  );
}
