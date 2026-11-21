"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BottomActionBar, BottomActionBarSpacer, BottomSheet, Button, Loading, RetryNotice, ScreenHeader, Tag, useToast } from "@/components/ui";
import { ESSAY_RULES, getMaterialBox, getSuggestion, type MaterialCard } from "@/lib/api";
import { isNewEssayDone, newFlowId, useLeaveFinishedFlow } from "@/lib/finishedFlow";
import { newEssayHref, readNewEssayParams, type NewEssayParams } from "@/lib/newEssayParams";
import { routes } from "@/lib/routes";
import { useOnboardingRedirect } from "@/lib/useOnboardingRedirect";
import { useDirectStart } from "./useDirectStart";
import { moveEssayRequest } from "@/lib/essayRequestStore";

/**
 * N120 고른 소재: 소재 확인·빼기·추가만. 추천 흐름·요청사항은 AI 초안 3단계(요청)에서 (목록 20번 변경)
 * - 고른 소재: 고른 순서대로, ×로 빼기
 * - [+ 소재 추가] → '소재 추가' 시트 (목록 4번, N110으로 넘어가지 않음): 불러온 소재 중 고르지 않은 것.
 *   여러 개 체크 → [추가 (n)] → 체크한 순서대로 m 뒤에 붙인다. 최대 ESSAY_RULES.materialsMax개를 넘지 않게 막고 안내.
 *   더 고를 소재가 없으면 버튼을 막고 '더 고를 소재가 없어요'
 *   소재 정보는 소재함(GET /materials)에서 찾는다. 없는 id(삭제됨)는 빼고 '삭제된 소재는 뺐어요'
 * - 소재 0개: [AI로 초안 만들기] 막고 버튼 위에 '소재를 1개 이상 골라 주세요'. [직접 쓰기]는 됨
 * - 빼거나 정리한 값은 주소(m·s)에도 바로 반영 → 새로고침해도 유지. 없는 제안은 s를 빼고, 적어 둔 요청사항은 새 키로 옮김
 * - 흐름 id(f): 없으면(홈 제안 카드·N130에서 바로 옴) 만들어 주소에 붙인다. 다음 화면으로 그대로 넘김.
 *   이 흐름에서 글을 저장한 뒤 뒤로 가기로 오면 내 서재로 (목록 7번)
 *
 * 새로 들어올 때마다 처음부터 (key = bfcacheId). 주소만 바꾸는 갱신에서는 그대로
 */
export default function DirectionScreen() {
  const { bfcacheId } = useRouter();
  const search = useSearchParams();
  // 새로 들어올 때(bfcacheId가 바뀔 때)의 주소 값으로 시작한다.
  // 이 화면이 주소를 바꾸는(replace) 동안에는 bfcacheId가 그대로라 다시 시작하지 않는다
  const [snapshot, setSnapshot] = useState(() => ({ id: bfcacheId, params: withFlowId(readNewEssayParams(search)) }));
  if (snapshot.id !== bfcacheId) setSnapshot({ id: bfcacheId, params: withFlowId(readNewEssayParams(search)) });
  return <Direction key={snapshot.id} initial={snapshot.params} urlHasFlow={search.has("f")} />;
}

/** 흐름 id가 없으면 새로 만든다 (주소에는 Direction이 붙임) */
const withFlowId = (params: NewEssayParams): NewEssayParams => (params.f ? params : { ...params, f: newFlowId() });

function Direction({ initial, urlHasFlow }: { initial: NewEssayParams; urlHasFlow: boolean }) {
  useLeaveFinishedFlow(() => isNewEssayDone(initial.f));
  const router = useRouter();
  const toast = useToast();
  const goOnboardingIfNeeded = useOnboardingRedirect();

  const [params, setParams] = useState<NewEssayParams>(initial);
  const [materials, setMaterials] = useState<MaterialCard[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const cleaned = useRef(false);
  const direct = useDirectStart();
  const [addOpen, setAddOpen] = useState(false);
  /** 소재 추가 시트에서 체크한 순서 */
  const [adding, setAdding] = useState<string[]>([]);
  /** [추가]를 눌렀나. 시트가 다 닫힌 뒤 붙인다 (뒤로가기 기록 정리 뒤 주소를 바꾸게) */
  const addChosen = useRef(false);

  /** 값을 바꾸고 주소에도 반영 (방문 기록은 늘리지 않음) */
  const update = (next: NewEssayParams) => {
    setParams(next);
    router.replace(newEssayHref(routes.newDirection, next), { scroll: false });
  };

  // 주소에 흐름 id가 없으면 붙인다 (방문 기록은 늘리지 않음)
  useEffect(() => {
    if (!urlHasFlow) router.replace(newEssayHref(routes.newDirection, initial), { scroll: false });
  }, [urlHasFlow, initial, router]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getMaterialBox(), initial.s ? getSuggestion(initial.s) : Promise.resolve(null)]).then(([box, sg]) => {
      if (cancelled) return;
      if (!box.ok) {
        if (!goOnboardingIfNeeded(box.error)) setFailed(true);
        return;
      }
      setMaterials(box.data.materials);
      setFailed(false);
      if (sg && !sg.ok && goOnboardingIfNeeded(sg.error)) return;

      // 처음 한 번: 없는 소재(삭제됨)·없는 제안을 정리
      if (cleaned.current) return;
      cleaned.current = true;
      const usable = initial.m.filter((id) => box.data.materials.some((m) => m.id === id));
      const dropSuggestion = !!sg && !sg.ok && sg.error.code === "suggestion_not_found";
      if (usable.length !== initial.m.length) toast("삭제된 소재는 뺐어요");
      if (usable.length !== initial.m.length || dropSuggestion) {
        const next = { ...initial, m: usable, s: dropSuggestion ? null : initial.s };
        if (dropSuggestion) moveEssayRequest(initial, next);
        setParams(next);
        router.replace(newEssayHref(routes.newDirection, next), { scroll: false });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [attempt, initial, goOnboardingIfNeeded, router, toast]);

  const header = <ScreenHeader title="고른 소재" back />;

  if (failed && !materials) {
    return (
      <>
        {header}
        <div className="px-5 pt-6">
          <RetryNotice message="연결이 불안정해요" onRetry={() => setAttempt((n) => n + 1)} />
        </div>
      </>
    );
  }

  if (!materials) {
    return (
      <>
        {header}
        <Loading fullScreen />
      </>
    );
  }

  const byId = new Map(materials.map((m) => [m.id, m]));
  const chosen = params.m.map((id) => byId.get(id)).filter((m): m is MaterialCard => !!m);
  const empty = chosen.length === 0;
  /** 소재 추가 시트에 보일 것: 고르지 않은 소재 */
  const addable = materials.filter((m) => !params.m.includes(m.id));
  const room = Math.max(0, ESSAY_RULES.materialsMax - params.m.length);

  const toggleAdding = (id: string) => {
    if (adding.includes(id)) {
      setAdding(adding.filter((x) => x !== id));
      return;
    }
    if (adding.length >= room) {
      toast(`소재는 ${ESSAY_RULES.materialsMax}개까지 고를 수 있어요`);
      return;
    }
    setAdding([...adding, id]);
  };

  const onAddSheetClosed = () => {
    setAddOpen(false);
    if (!addChosen.current) return;
    addChosen.current = false;
    if (adding.length > 0) update({ ...params, m: [...params.m, ...adding].slice(0, ESSAY_RULES.materialsMax) });
  };

  return (
    <>
      {header}
      <div className="flex flex-col gap-6 px-5 pt-5 pb-4">
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-ink-soft">고른 소재 {chosen.length}개</h2>
          {chosen.length > 0 && (
            <ol className="divide-y divide-line rounded-2xl border border-line">
              {chosen.map((m, i) => (
                <li key={m.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="text-sm text-ink-mute">{i + 1}.</span>
                  <span className="min-w-0 flex-1 truncate text-[15px]">{m.title?.trim() || "(제목 없음)"}</span>
                  <button
                    type="button"
                    aria-label={`${m.title ?? "소재"} 빼기`}
                    onClick={() => update({ ...params, m: params.m.filter((x) => x !== m.id) })}
                    className="flex size-8 items-center justify-center rounded-full text-ink-mute active:bg-subtle"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ol>
          )}
          <div className="flex flex-col items-start">
            <Button
              variant="ghost"
              disabled={addable.length === 0}
              aria-describedby={addable.length === 0 ? "add-material-none" : undefined}
              onClick={() => {
                setAdding([]);
                setAddOpen(true);
              }}
            >
              + 소재 추가
            </Button>
            {addable.length === 0 && (
              <p id="add-material-none" className="px-3 text-xs text-ink-mute">
                더 고를 소재가 없어요
              </p>
            )}
          </div>
        </section>

      </div>

      <BottomActionBarSpacer />
      <BottomActionBar>
        {/* 고른 소재가 없으면 버튼 위에 안내 (목록 21번) */}
        {empty && <p className="mb-2 text-center text-sm text-danger">소재를 1개 이상 골라 주세요</p>}
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" size="lg" loading={direct.checking} onClick={() => void direct.start(params)}>
            직접 쓰기
          </Button>
          <Button size="lg" disabled={empty} onClick={() => router.push(newEssayHref(routes.newAiStyle, params))}>
            AI로 초안 만들기
          </Button>
        </div>
      </BottomActionBar>
      {direct.dialog}

      {/* 소재 추가 (목록 4번) */}
      <BottomSheet open={addOpen} onClose={onAddSheetClosed} title="소재 추가">
        {({ close }) => (
          <div className="flex flex-col gap-3">
            {room === 0 ? (
              <p className="text-sm text-ink-soft">소재는 {ESSAY_RULES.materialsMax}개까지 고를 수 있어요</p>
            ) : (
              <p className="text-sm text-ink-soft">
                고른 순서대로 뒤에 붙어요 · {room}개 더 고를 수 있어요
              </p>
            )}
            <ul className="-mx-1 flex max-h-[50vh] flex-col gap-1 overflow-y-auto px-1">
              {addable.map((m) => {
                const order = adding.indexOf(m.id);
                const checked = order >= 0;
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      disabled={!checked && adding.length >= room}
                      onClick={() => toggleAdding(m.id)}
                      className={`flex w-full items-start gap-3 rounded-xl border px-3 py-3 text-left disabled:opacity-40 ${
                        checked ? "border-primary bg-primary-soft/40" : "border-line active:bg-subtle"
                      }`}
                    >
                      <span
                        aria-hidden
                        className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border text-xs ${
                          checked ? "border-primary bg-primary text-white" : "border-line"
                        }`}
                      >
                        {checked ? order + 1 : ""}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-semibold">{materialName(m)}</span>
                        {m.topics.length > 0 && (
                          <span className="mt-1 flex flex-wrap gap-1">
                            {m.topics.map((t) => (
                              <Tag key={t.id}>{t.name}</Tag>
                            ))}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <Button
              block
              size="lg"
              disabled={adding.length === 0}
              onClick={() => {
                addChosen.current = true;
                close();
              }}
            >
              추가 ({adding.length})
            </Button>
          </div>
        )}
      </BottomSheet>
    </>
  );
}

/** 소재 이름: 제목, 없으면 요약 앞부분 */
function materialName(m: MaterialCard): string {
  const title = m.title?.trim();
  if (title) return title;
  const summary = m.summary?.trim();
  if (!summary) return "(제목 없음)";
  return summary.length > 24 ? `${summary.slice(0, 24)}…` : summary;
}
