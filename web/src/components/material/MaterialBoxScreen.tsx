"use client";

import { useEffect, useState } from "react";
import { ButtonLink, Chip, ChipRow, Loading, MaterialCard, RetryNotice, ScreenHeader, type MaterialCardStatus } from "@/components/ui";
import { getMaterialBox, TOPICS, type MaterialBox, type RecordCard } from "@/lib/api";
import { formatMonthDay, RECORD_TYPE_LABEL, titleOrPreview } from "@/lib/format";
import { newEssayHref } from "@/lib/newEssayParams";
import { collectRoutes, routes } from "@/lib/routes";
import { useOnboardingRedirect } from "@/lib/useOnboardingRedirect";

/** 확인 대기 카드 표시 (B label → 카드 상태) */
const PENDING_STATUS: Record<NonNullable<RecordCard["label"]>, MaterialCardStatus> = {
  to_confirm: "review",
  analyzing: "analyzing",
  empty: "empty",
  failed: "failed",
};

/** 원본만 보관 카드: 분석 중·확인해 주세요가 아니면 '원본만 보관' */
const keptOriginalStatus = (label: RecordCard["label"]): MaterialCardStatus =>
  label === "analyzing" ? "analyzing" : label === "to_confirm" ? "review" : "rawOnly";

/**
 * M110 소재함 (UI 설계서 v7 13쪽, B GET /materials)
 * 확인 대기 → 임시 저장 기록 → 주제 칩 + 보관한 소재 → 원본만 보관한 기록(접힌 구역)
 * 화면에 다시 올 때마다 새로 불러온다 (cacheComponents의 Activity: 보였다가 숨으면 effect가 다시 돈다)
 */
export default function MaterialBoxScreen() {
  const goOnboardingIfNeeded = useOnboardingRedirect();
  const [box, setBox] = useState<MaterialBox | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [topic, setTopic] = useState<number | null>(null);
  const [rawOpen, setRawOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getMaterialBox().then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setBox(res.data);
        setFailed(false);
      } else if (!goOnboardingIfNeeded(res.error)) {
        setFailed(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [attempt, goOnboardingIfNeeded]);

  const header = (
    <ScreenHeader
      title="소재함"
      right={
        <ButtonLink href={newEssayHref(routes.newSelect, { from: "materials" })} variant="secondary" className="h-9 px-3 text-sm">
          새 글 쓰기
        </ButtonLink>
      }
    />
  );

  if (failed && !box) {
    return (
      <>
        {header}
        <div className="px-5 pt-6">
          <RetryNotice
            message="연결이 불안정해요"
            onRetry={() => {
              setFailed(false);
              setAttempt((n) => n + 1);
            }}
          />
        </div>
      </>
    );
  }

  if (!box) {
    return (
      <>
        {header}
        <Loading fullScreen />
      </>
    );
  }

  const empty =
    box.pending.length === 0 && box.drafts.length === 0 && box.materials.length === 0 && box.kept_originals.length === 0;

  if (empty) {
    return (
      <>
        {header}
        <section className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <div>
            <p className="text-[15px] font-semibold">아직 모은 소재가 없어요</p>
            <p className="mt-1 text-sm text-ink-soft">오늘 있었던 일 하나를 적어 볼까요?</p>
          </div>
          {/* 홈의 [소재 모으기]에서 방식을 고른다 (H120) */}
          <ButtonLink href={routes.home} variant="secondary">
            소재 모으기
          </ButtonLink>
        </section>
      </>
    );
  }

  // 주제 칩: 전체 + 보관한 소재에 있는 주제만 (정해진 순서)
  const usedTopicIds = new Set(box.materials.flatMap((m) => m.topics.map((t) => t.id)));
  const topicChips = TOPICS.filter((t) => usedTopicIds.has(t.id));
  const selectedTopic = topic !== null && usedTopicIds.has(topic) ? topic : null;
  const materials = selectedTopic === null ? box.materials : box.materials.filter((m) => m.topics.some((t) => t.id === selectedTopic));

  return (
    <>
      {header}
      <div className="flex flex-col gap-7 px-5 pt-4 pb-6">
        {failed && (
          <RetryNotice message="새로 불러오지 못했어요" onRetry={() => setAttempt((n) => n + 1)} />
        )}

        {box.pending.length > 0 && (
          <Section title={`확인 대기 ${box.pending.length}`}>
            {box.pending.map((c) => (
              <MaterialCard
                key={c.record_id}
                href={routes.materialReview(c.record_id)}
                status={PENDING_STATUS[c.label ?? "failed"]}
                title={titleOrPreview(c.title, c.preview)}
                summary={RECORD_TYPE_LABEL[c.record_type]}
                date={formatMonthDay(c.date)}
              />
            ))}
          </Section>
        )}

        {box.drafts.length > 0 && (
          <Section title="임시 저장 기록">
            {box.drafts.map((c) => (
              <MaterialCard
                key={c.record_id}
                href={c.record_type === "free" ? collectRoutes.free("draft") : collectRoutes.ai("draft")}
                status="draft"
                title={RECORD_TYPE_LABEL[c.record_type]}
                summary={c.preview || undefined}
                date={formatMonthDay(c.date)}
              />
            ))}
          </Section>
        )}

        <Section title={`보관한 소재 ${box.materials.length}`}>
          {topicChips.length > 0 && (
            <ChipRow>
              <Chip selected={selectedTopic === null} onClick={() => setTopic(null)}>
                전체
              </Chip>
              {topicChips.map((t) => (
                <Chip key={t.id} selected={selectedTopic === t.id} onClick={() => setTopic(t.id)}>
                  {t.name}
                </Chip>
              ))}
            </ChipRow>
          )}
          {materials.length === 0 ? (
            <p className="rounded-2xl bg-subtle px-4 py-6 text-center text-sm text-ink-soft">
              {box.materials.length === 0 ? "아직 보관한 소재가 없어요" : "이 주제의 소재가 없어요"}
            </p>
          ) : (
            materials.map((m) => (
              <MaterialCard
                key={m.id}
                href={routes.material(m.id)}
                title={m.title?.trim() || "(제목 없음)"}
                summary={m.summary ?? undefined}
                topics={m.topics.map((t) => t.name)}
                date={formatMonthDay(m.created_at)}
                usedCount={m.essay_count}
              />
            ))
          )}
        </Section>

        {box.kept_originals.length > 0 && (
          <section className="flex flex-col gap-3 border-t border-line pt-5">
            <button
              type="button"
              aria-expanded={rawOpen}
              onClick={() => setRawOpen((o) => !o)}
              className="flex items-center justify-between text-left text-[15px] font-bold"
            >
              원본만 보관한 기록 {box.kept_originals.length}개 <span aria-hidden>{rawOpen ? "▴" : "▾"}</span>
            </button>
            {rawOpen &&
              box.kept_originals.map((c) => (
                <MaterialCard
                  key={c.record_id}
                  href={routes.keptRecord(c.record_id)}
                  status={keptOriginalStatus(c.label)}
                  title={titleOrPreview(c.title, c.preview)}
                  summary={RECORD_TYPE_LABEL[c.record_type]}
                  date={formatMonthDay(c.date)}
                />
              ))}
          </section>
        )}
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[15px] font-bold">{title}</h2>
      {children}
    </section>
  );
}
