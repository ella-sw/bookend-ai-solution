"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  BottomActionBar,
  BottomActionBarSpacer,
  Button,
  Chip,
  ChipRow,
  Loading,
  MaterialCard,
  RetryNotice,
  ScreenHeader,
} from "@/components/ui";
import { getMaterialBox, getRelatedMaterials, TOPICS, type MaterialCard as MaterialCardData, type RelatedMaterial } from "@/lib/api";
import { formatMonthDay } from "@/lib/format";
import { isNewEssayDone, useEnsureFlowId, useLeaveFinishedFlow } from "@/lib/finishedFlow";
import { newEssayHref, readNewEssayParams, searchKeyWithoutFlow, type NewEssayParams } from "@/lib/newEssayParams";
import { routes } from "@/lib/routes";
import { useOnboardingRedirect } from "@/lib/useOnboardingRedirect";
import { useDirectStart } from "./useDirectStart";

/** 함께 쓰면 좋은 소재를 묶어 부르는 간격 */
const RELATED_DELAY_MS = 300;

/**
 * N110 소재 고르기 (UI 설계서 v7 17쪽, B GET /materials · /materials/related)
 * - 보관 확정 소재만. 주제 칩으로 거르고 체크 상자로 고르기/해제. 고른 소재는 위에 따로
 * - 함께 쓰면 좋은 소재: 1개 이상 고르면 (0.3초 묶어서) 참고로 보여 준다. 고르지 않아도 됨
 * - 들어올 때 m이 있으면 그 소재가 선택된 상태 (N120 [+ 소재 추가], N130 [소재 바꾸기], M120·M130)
 * - [다음 (N개)] → N120 (m 고른 순서, s·from·f 그대로) / [소재 없이 직접 쓰기] → N140 (from = no_material, f 그대로)
 * - 흐름 id(f)가 없으면 만들어 주소에 붙인다. 이 흐름에서 글을 저장한 뒤 뒤로 가기로 오면 내 서재로 (목록 7번)
 *
 * 새로 들어올 때마다 주소의 값으로 처음부터 (key = bfcacheId + 주소 검색값, f는 빼고)
 */
export default function MaterialSelectScreen() {
  const { bfcacheId } = useRouter();
  const search = useSearchParams();
  return <MaterialSelect key={`${bfcacheId}:${searchKeyWithoutFlow(search.toString())}`} initial={readNewEssayParams(search)} query={search.toString()} />;
}

function MaterialSelect({ initial, query }: { initial: NewEssayParams; query: string }) {
  useLeaveFinishedFlow(() => isNewEssayDone(initial.f));
  useEnsureFlowId(routes.newSelect, query);
  const router = useRouter();
  const goOnboardingIfNeeded = useOnboardingRedirect();

  const [materials, setMaterials] = useState<MaterialCardData[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  /** 고른 소재 id, 고른 순서대로 */
  const [selected, setSelected] = useState<string[]>(initial.m);
  const [topic, setTopic] = useState<number | null>(null);
  const [related, setRelated] = useState<RelatedMaterial[]>([]);
  const direct = useDirectStart();

  useEffect(() => {
    let cancelled = false;
    void getMaterialBox().then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setMaterials(res.data.materials);
        setFailed(false);
      } else if (!goOnboardingIfNeeded(res.error)) {
        setFailed(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [attempt, goOnboardingIfNeeded]);

  // 고른 것 중 지금 쓸 수 있는 소재만 (삭제된 소재는 목록에 없음)
  const usable = materials ? selected.filter((id) => materials.some((m) => m.id === id)) : [];
  const usableKey = usable.join(",");

  // 함께 쓰면 좋은 소재: 고를 때마다 0.3초 묶어서. 실패하면 조용히 숨긴다 (참고용)
  useEffect(() => {
    const ids = usableKey ? usableKey.split(",") : [];
    let cancelled = false;
    const timer = setTimeout(() => {
      if (ids.length === 0) {
        setRelated([]);
        return;
      }
      void getRelatedMaterials(ids).then((res) => {
        if (!cancelled) setRelated(res.ok ? res.data : []);
      });
    }, RELATED_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [usableKey]);

  const toggle = (id: string) =>
    setSelected((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));

  const goNext = () => {
    if (usable.length === 0) return;
    router.push(newEssayHref(routes.newDirection, { m: usable, s: initial.s, from: initial.from, f: initial.f }));
  };

  /** 소재 없이 직접 쓰기 (임시 저장이 있으면 H121 이어 쓰기 확인) */
  const writeWithout = () => void direct.start({ m: [], s: null, from: "no_material", f: initial.f });

  const header = <ScreenHeader title="소재 고르기" back />;

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

  if (materials.length === 0) {
    return (
      <>
        {header}
        <section className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <p className="text-[15px] font-semibold">아직 보관한 소재가 없어요</p>
          <Button variant="secondary" loading={direct.checking} onClick={writeWithout}>
            소재 없이 직접 쓰기
          </Button>
        </section>
        {direct.dialog}
      </>
    );
  }

  const byId = new Map(materials.map((m) => [m.id, m]));
  const usedTopicIds = new Set(materials.flatMap((m) => m.topics.map((t) => t.id)));
  const topicChips = TOPICS.filter((t) => usedTopicIds.has(t.id));
  const list = topic === null ? materials : materials.filter((m) => m.topics.some((t) => t.id === topic));
  const selectedMaterials = usable.map((id) => byId.get(id)!).filter(Boolean);

  return (
    <>
      {header}
      <div className="flex flex-col gap-6 px-5 pt-4 pb-4">
        <p className="text-[15px] font-semibold">
          쓸 소재를 골라 주세요{usable.length > 0 && <span className="text-primary"> · {usable.length}개 선택</span>}
        </p>

        {selectedMaterials.length > 0 && (
          <section className="flex flex-col gap-2">
            {selectedMaterials.map((m) => (
              <SelectableMaterial key={m.id} material={m} selected onToggle={() => toggle(m.id)} />
            ))}
          </section>
        )}

        {related.length > 0 && (
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-ink-soft">함께 쓰면 좋은 소재</h2>
            {related.map((m) => (
              <SelectableMaterial
                key={m.id}
                material={m}
                selected={selected.includes(m.id)}
                onToggle={() => toggle(m.id)}
                note={[
                  m.shared_topics.length > 0 ? `같은 주제: ${m.shared_topics.join(", ")}` : null,
                  m.shared_keywords.length > 0 ? `같은 키워드: ${m.shared_keywords.join(", ")}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              />
            ))}
          </section>
        )}

        <section className="flex flex-col gap-3">
          {topicChips.length > 0 && (
            <ChipRow>
              <Chip selected={topic === null} onClick={() => setTopic(null)}>
                전체
              </Chip>
              {topicChips.map((t) => (
                <Chip key={t.id} selected={topic === t.id} onClick={() => setTopic(t.id)}>
                  {t.name}
                </Chip>
              ))}
            </ChipRow>
          )}
          {list.map((m) => (
            <SelectableMaterial key={m.id} material={m} selected={selected.includes(m.id)} onToggle={() => toggle(m.id)} />
          ))}
        </section>
      </div>

      <BottomActionBarSpacer height="8rem" />
      <BottomActionBar>
        <div className="flex flex-col gap-2">
          <Button block size="lg" disabled={usable.length === 0} onClick={goNext}>
            다음{usable.length > 0 ? ` (${usable.length}개)` : ""}
          </Button>
          <Button block variant="ghost" loading={direct.checking} onClick={writeWithout}>
            소재 없이 직접 쓰기
          </Button>
        </div>
      </BottomActionBar>
      {direct.dialog}
    </>
  );
}

/** 체크 상자가 있는 소재 카드 (누르면 고르기·해제) */
function SelectableMaterial({
  material,
  selected,
  onToggle,
  note,
}: {
  material: MaterialCardData;
  selected: boolean;
  onToggle: () => void;
  note?: string;
}) {
  return (
    <button type="button" role="checkbox" aria-checked={selected} onClick={onToggle} className="flex items-start gap-3 text-left">
      <span
        aria-hidden
        className={`mt-4 flex size-5 shrink-0 items-center justify-center rounded-md border text-xs ${
          selected ? "border-primary bg-primary text-white" : "border-line bg-surface"
        }`}
      >
        {selected && "✓"}
      </span>
      <span className="min-w-0 flex-1">
        <MaterialCard
          title={material.title?.trim() || "(제목 없음)"}
          summary={material.summary ?? undefined}
          topics={material.topics.map((t) => t.name)}
          date={formatMonthDay(material.created_at)}
          selected={selected}
        />
        {note && <span className="mt-1 block px-1 text-xs text-ink-mute">{note}</span>}
      </span>
    </button>
  );
}
