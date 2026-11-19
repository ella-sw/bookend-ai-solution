"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useLeaveGuard } from "@/components/collect/useLeaveGuard";
import { BottomActionBar, BottomActionBarSpacer, Button, ConfirmDialog, Loading, ScreenHeader, useBackToClose, useToast } from "@/components/ui";
import { Overlay } from "@/components/ui/Overlay";
import { getEssay, newSaveToken, saveRegeneration, type Essay, type RegenResult } from "@/lib/api";
import { isEssayDetailSeen, useLeaveFinishedFlow } from "@/lib/finishedFlow";
import { regenStyleHref } from "@/lib/newEssayParams";
import { getRegenResult, removeRegenResult } from "@/lib/regenResultStore";
import { routes } from "@/lib/routes";
import { useOnboardingRedirect } from "@/lib/useOnboardingRedirect";
import { EssayInfoLine, EssayText } from "./EssayView";

/**
 * W340 다시 만든 결과 + W341 저장 창 (?essay=&request=, UI 설계서 v7 23쪽, 목록 28번)
 * - 결과는 W310에서 sessionStorage(regen:{essayId}:{request_id})에 넣어 둔 것 → 새로고침해도 남음.
 *   없으면 '저장하지 않은 결과는 사라졌어요' + [글 보기]
 * - 정보 줄 'v2를 바탕으로 다시 만든 글 · 담백함 · 장문 · 1,240자' (범위 밖이면 '목표 범위 밖', 목록 23번)
 *   바탕 버전 이름은 결과의 based_on_version_id로 글(getEssay)의 버전에서 찾는다. 못 찾으면 '이전 버전을 바탕으로 다시 만든 글'.
 *   같은 글을 여러 번 다시 만들었으면(regen_count > 1) 뒤에 ' · 3번째 결과'
 * - 삭제한 소재를 빼고 만들었으면 안내
 * - [다시 만들기] → W310 다시 만들기 모드 (이 결과 바탕) / [저장] → W341
 * - 저장 전에 나가면(헤더 [뒤로]·브라우저 뒤로 가기) 확인 (목록 10번, W211과 같은 모양):
 *   '저장하지 않고 나갈까요?' [저장하기](W341 열기) / [나가기] / [계속 보기]. 저장한 뒤에는 확인 없이 이동
 * - 뒤로 가기로 다시 열었는데 이 글의 글 상세(L120)를 연 적이 있으면 내 서재로 (목록 7번)
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

type ExitChoice = "save" | "leave" | null;

/** 목적격 조사: '초안을', 'v1을', 'v2를' (숫자는 읽는 소리로) */
function objectParticle(word: string): "을" | "를" {
  const last = word.trim().slice(-1);
  if (/[0-9]/.test(last)) return "013678".includes(last) ? "을" : "를";
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 === 0 ? "를" : "을";
  return "를";
}

/** 정보 줄 앞부분: 'v2를 바탕으로 다시 만든 글 · 3번째 결과' */
function regenLead(baseLabel: string | null, regenCount: number) {
  const base = baseLabel ? `${baseLabel}${objectParticle(baseLabel)} 바탕으로 다시 만든 글` : "이전 버전을 바탕으로 다시 만든 글";
  return regenCount > 1 ? `${base} · ${regenCount}번째 결과` : base;
}

function RegenResultView({ essayId, requestId }: { essayId: string; requestId: number }) {
  useLeaveFinishedFlow(() => isEssayDetailSeen(essayId));
  const router = useRouter();
  // 이 탭에 남겨 둔 결과 (서버는 저장 안 한 결과를 다시 돌려주지 않음).
  // sessionStorage는 브라우저에만 있으므로 화면을 띄운 뒤 읽는다 (서버에서 먼저 그릴 때와 어긋나지 않게)
  const [result, setResult] = useState<RegenResult | null | undefined>(undefined);
  /** 바탕 버전 이름·다음 버전 번호에 쓰는 글 (못 불러오면 null) */
  const [essay, setEssay] = useState<Essay | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [exitOpen, setExitOpen] = useState(false);
  /** 저장에 성공함 → 나가기 확인 없이 이동 */
  const [saved, setSaved] = useState(false);
  /** 나가기 확인에서 고른 것. 팝업이 다 닫힌 뒤 실행 */
  const exitChoice = useRef<ExitChoice>(null);

  const dirty = !!result && !saved;
  const { leave } = useLeaveGuard({ dirty, onBlocked: () => setExitOpen(true) });

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

  // 바탕 버전 이름 (W341 다음 버전 번호에도 씀)
  useEffect(() => {
    if (!result) return;
    let cancelled = false;
    void getEssay(result.essay_id).then((res) => {
      if (!cancelled && res.ok) setEssay(res.data);
    });
    return () => {
      cancelled = true;
    };
  }, [result]);

  const requestExit = () => {
    if (dirty) setExitOpen(true);
    else leave();
  };

  const onExitDialogClosed = () => {
    setExitOpen(false);
    const choice = exitChoice.current;
    exitChoice.current = null;
    if (choice === "save") setSaveOpen(true);
    if (choice === "leave") leave();
  };

  /** W341 저장 끝 (성공 또는 이미 저장됨): 확인 없이 글 상세로 */
  const onSaved = (href: string) => {
    setSaved(true);
    // 나가기 확인 기록 바로 위면 그 기록을 걷고 이동한다. 아니면(개발 모드에서 저장 창 기록이 두 번 쌓인 경우 등)
    // 지금 자리를 글 상세로 바꾼다. 남은 W340 자리는 뒤로 가기로 와도 내 서재로 보낸다 (목록 7번)
    if ((window.history.state as Record<string, unknown> | null)?.rowflowLeaveGuard === true) leave(href);
    else router.replace(href);
  };

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

  const baseLabel = essay?.versions.find((v) => v.id === result.based_on_version_id)?.label ?? null;
  const nextNo = essay ? Math.max(0, ...essay.versions.map((v) => v.version_no)) + 1 : null;

  return (
    <>
      <ScreenHeader title="다시 만든 글" back onBack={requestExit} />
      <div className="flex flex-col gap-5 px-5 pt-5 pb-4">
        <EssayInfoLine
          lead={regenLead(baseLabel, result.regen_count)}
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

      {saveOpen && <SaveVersionDialog result={result} nextNo={nextNo} onClose={() => setSaveOpen(false)} onSaved={onSaved} />}

      {/* 저장하지 않고 나가기 확인 (W211과 같은 모양). 고른 동작은 팝업이 닫힌 뒤 onExitDialogClosed에서 실행 */}
      <ConfirmDialog
        open={exitOpen}
        onClose={onExitDialogClosed}
        title="저장하지 않고 나갈까요?"
        description="이 결과는 사라져요."
        actions={[
          { label: "저장하기", variant: "primary", onClick: () => (exitChoice.current = "save") },
          { label: "나가기", onClick: () => (exitChoice.current = "leave") },
          { label: "계속 보기", variant: "ghost", onClick: () => (exitChoice.current = null) },
        ]}
      />
    </>
  );
}

/**
 * W341 저장 창: 'v{N}로 저장할까요?' (N = 지금 버전 중 가장 큰 번호 + 1, 초안만 있으면 v1)
 * - save_token은 창을 열 때 하나, [다시 시도]에도 같은 값 (두 번 눌러도 버전은 하나)
 * - 다음 버전 번호는 화면이 이미 불러온 글에서(nextNo). 아직 없으면 창을 열 때 불러온다
 * - 성공 → 결과 지우고 L120 (이 창이 닫힌 뒤 onSaved가 W340 자리를 L120으로 바꾼다, 나가기 확인 없음)
 * - 실패 → 창에 '저장하지 못했어요' + [다시 시도], 결과 유지. 409 no_result → 토스트 + 글 보기
 */
function SaveVersionDialog({
  result,
  nextNo: knownNextNo,
  onClose,
  onSaved,
}: {
  result: RegenResult;
  nextNo: number | null;
  onClose: () => void;
  onSaved: (href: string) => void;
}) {
  const toast = useToast();
  const goOnboardingIfNeeded = useOnboardingRedirect();
  const titleId = useId();
  const [loadedNextNo, setLoadedNextNo] = useState<number | null>(null);
  const nextNo = knownNextNo ?? loadedNextNo;
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [saveToken] = useState(newSaveToken);
  const busy = useRef(false);
  /** 창이 닫힌 뒤 갈 곳 */
  const goAfterClose = useRef<string | null>(null);

  const { close } = useBackToClose(true, () => {
    onClose();
    if (goAfterClose.current) onSaved(goAfterClose.current);
  });

  // 새 버전 번호: 지금 버전 중 가장 큰 번호 + 1 (화면이 아직 못 불러왔을 때만)
  useEffect(() => {
    if (knownNextNo !== null) return;
    let cancelled = false;
    void getEssay(result.essay_id).then((res) => {
      if (!cancelled && res.ok) setLoadedNextNo(Math.max(0, ...res.data.versions.map((v) => v.version_no)) + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [knownNextNo, result.essay_id]);

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
