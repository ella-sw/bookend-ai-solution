"use client";

import { useId, useState } from "react";
import {
  MATERIAL_RULES,
  TOPICS,
  type AnalysisMaterial,
  type Original,
} from "@/lib/api";

/*
 * 소재 고치는 칸 (M120 후보 확인·직접 정리하기, M131 소재 정보 고치기가 같이 쓴다)
 * 규칙은 B ConfirmIn·EditIn과 같다: 제목 ≤50(선택), 요약 1~200, 키워드 10개·각 30자, 주제 1~10개
 */

/** 고치는 칸 */
export type Form = {
  title: string;
  summary: string;
  keywords: string[];
  topics: number[];
};
export type FieldErrors = Partial<Record<keyof Form | "form", string>>;

export const formOf = (
  m: Pick<AnalysisMaterial, "title" | "summary" | "keywords" | "topics"> | null,
): Form => ({
  title: m?.title ?? "",
  summary: m?.summary ?? "",
  keywords: m?.keywords ?? [],
  topics: m?.topics.map((t) => t.id) ?? [],
});

export const sameForm = (a: Form, b: Form) =>
  a.title === b.title &&
  a.summary === b.summary &&
  a.keywords.join("\n") === b.keywords.join("\n") &&
  [...a.topics].sort().join(",") === [...b.topics].sort().join(",");

/** B ConfirmIn과 같은 규칙으로 화면에서 먼저 확인 */
export function validate(form: Form): FieldErrors {
  const errors: FieldErrors = {};
  if (form.title.trim().length > MATERIAL_RULES.titleMax)
    errors.title = `제목은 ${MATERIAL_RULES.titleMax}자까지 적을 수 있어요`;
  const summary = form.summary.trim();
  if (!summary) errors.summary = "소재 요약을 적어 주세요";
  else if (summary.length > MATERIAL_RULES.summaryMax)
    errors.summary = `요약은 ${MATERIAL_RULES.summaryMax}자까지 적을 수 있어요`;
  if (form.topics.length === 0) errors.topics = "주제를 하나 이상 골라 주세요";
  return errors;
}

export function MaterialFields({
  form,
  setForm,
  errors,
  disabled,
  titleEditable = true,
}: {
  form: Form;
  setForm: (updater: (f: Form) => Form) => void;
  errors: FieldErrors;
  disabled: boolean;
  /** false면 제목을 읽기 전용으로 (M131 소재 정보 고치기: 제목은 고칠 수 없음) */
  titleEditable?: boolean;
}) {
  // 보이는 글자(label)와 입력칸을 잇는 id
  const id = useId();
  const [keywordInput, setKeywordInput] = useState("");
  const [keywordError, setKeywordError] = useState<string | null>(null);

  const addKeyword = () => {
    const k = keywordInput.trim();
    if (!k) return;
    if (k.length > MATERIAL_RULES.keywordMax) {
      setKeywordError(
        `키워드는 ${MATERIAL_RULES.keywordMax}자까지 적을 수 있어요`,
      );
      return;
    }
    if (form.keywords.length >= MATERIAL_RULES.keywordsMax) {
      setKeywordError(
        `키워드는 ${MATERIAL_RULES.keywordsMax}개까지 넣을 수 있어요`,
      );
      return;
    }
    setKeywordError(null);
    setKeywordInput("");
    if (!form.keywords.includes(k))
      setForm((f) => ({ ...f, keywords: [...f.keywords, k] }));
  };

  const toggleTopic = (id: number) =>
    setForm((f) => ({
      ...f,
      topics: f.topics.includes(id)
        ? f.topics.filter((t) => t !== id)
        : [...f.topics, id],
    }));

  return (
    <>
      {!titleEditable ? (
        <Field label="제목">
          <p className="text-[15px] font-semibold">
            {form.title.trim() || "(제목 없음)"}
          </p>
        </Field>
      ) : (
        <Field label="제목 (선택)" error={errors.title} htmlFor={`${id}-title`}>
          <input
            id={`${id}-title`}
            type="text"
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            maxLength={MATERIAL_RULES.titleMax}
            disabled={disabled}
            className="h-11 w-full rounded-xl border border-line px-3 text-[15px] outline-none focus:border-ink disabled:opacity-60"
          />
        </Field>
      )}

      <Field
        label="소재"
        error={errors.summary}
        hint={`${form.summary.trim().length}/${MATERIAL_RULES.summaryMax}`}
        htmlFor={`${id}-summary`}
      >
        <textarea
          id={`${id}-summary`}
          value={form.summary}
          onChange={(e) => setForm((f) => ({ ...f, summary: e.target.value }))}
          maxLength={MATERIAL_RULES.summaryMax}
          rows={3}
          disabled={disabled}
          className="w-full resize-none rounded-xl border border-line px-3 py-2.5 text-[15px] leading-relaxed outline-none focus:border-ink disabled:opacity-60"
        />
      </Field>

      <Field label="키워드" error={keywordError ?? undefined} htmlFor={form.keywords.length < MATERIAL_RULES.keywordsMax ? `${id}-keyword` : undefined}>
        <div className="flex flex-wrap gap-2">
          {form.keywords.map((k) => (
            <span
              key={k}
              className="inline-flex h-8 items-center gap-1 rounded-full bg-subtle pr-1 pl-3 text-[13px]"
            >
              {k}
              <button
                type="button"
                aria-label={`${k} 빼기`}
                disabled={disabled}
                onClick={() =>
                  setForm((f) => ({
                    ...f,
                    keywords: f.keywords.filter((x) => x !== k),
                  }))
                }
                className="relative after:absolute after:-inset-2.5 after:content-[''] flex size-6 items-center justify-center rounded-full text-ink-mute active:bg-line"
              >
                ×
              </button>
            </span>
          ))}
          {form.keywords.length < MATERIAL_RULES.keywordsMax && (
            <form
              className="inline-flex h-8 items-center rounded-full border border-dashed border-line pr-1 pl-3"
              onSubmit={(e) => {
                e.preventDefault();
                addKeyword();
              }}
            >
              <input
                id={`${id}-keyword`}
                value={keywordInput}
                onChange={(e) => setKeywordInput(e.target.value)}
                maxLength={MATERIAL_RULES.keywordMax}
                disabled={disabled}
                placeholder="키워드"
                aria-label="키워드 추가"
                className="w-20 bg-transparent text-[13px] outline-none"
              />
              <button
                type="submit"
                aria-label="키워드 추가"
                disabled={disabled}
                className="relative after:absolute after:-inset-2.5 after:content-[''] flex size-6 items-center justify-center text-ink-soft"
              >
                +
              </button>
            </form>
          )}
        </div>
      </Field>

      <Field label="주제" error={errors.topics} groupId={`${id}-topics`}>
        <div role="group" aria-labelledby={`${id}-topics`} className="flex flex-wrap gap-2">
          {TOPICS.map((t) => {
            const selected = form.topics.includes(t.id);
            return (
              <button
                key={t.id}
                type="button"
                aria-pressed={selected}
                disabled={disabled}
                onClick={() => toggleTopic(t.id)}
                className={`inline-flex h-8 items-center rounded-full border px-3 text-[13px] ${
                  selected
                    ? "border-primary bg-primary font-semibold text-white"
                    : "border-line text-ink-soft active:bg-subtle"
                }`}
              >
                {t.name}
              </button>
            );
          })}
        </div>
      </Field>
    </>
  );
}

/**
 * 칸 하나: 보이는 이름 + 입력.
 * - htmlFor: 입력칸 id → 이름을 <label>로 잇는다 (화면 읽기가 입력칸 이름으로 읽음)
 * - groupId: 버튼 묶음(주제)의 이름 id (aria-labelledby로 씀)
 */
function Field({
  label,
  error,
  hint,
  htmlFor,
  groupId,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  htmlFor?: string;
  groupId?: string;
  children: React.ReactNode;
}) {
  const labelClass = "text-sm font-semibold text-ink-soft";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        {htmlFor ? (
          <label htmlFor={htmlFor} className={labelClass}>
            {label}
          </label>
        ) : (
          <span id={groupId} className={labelClass}>
            {label}
          </span>
        )}
        {hint && <span className="text-xs text-ink-mute">{hint}</span>}
      </div>
      {children}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

/** 원문 (읽기 전용): 자유 기록 본문 또는 문답 (답한 질문만) */
export function OriginalText({ original }: { original: Original }) {
  if (original.record_type === "free") {
    return (
      <div className="flex flex-col gap-2">
        {original.title && (
          <p className="font-semibold text-ink">{original.title}</p>
        )}
        <p className="whitespace-pre-wrap">{original.body}</p>
      </div>
    );
  }
  return (
    <dl className="flex flex-col gap-3">
      {original.messages.map((m) => (
        <div key={m.seq}>
          <dt className="font-semibold text-ink">{m.question}</dt>
          <dd className="mt-1 whitespace-pre-wrap">{m.answer}</dd>
        </div>
      ))}
    </dl>
  );
}
