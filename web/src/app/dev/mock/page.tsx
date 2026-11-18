"use client";

import { useState, useSyncExternalStore } from "react";
import { Button, ButtonLink, ScreenHeader } from "@/components/ui";
import {
  clearAllData,
  getAnalysis,
  getHomeSummary,
  getActiveQna,
  getFreeDraft,
  getMe,
  getMaterialBox,
  getQnaDraft,
  getTodayQuestions,
  hasSession,
  newSaveToken,
  QNA_RESUME_WINDOW_MS,
  saveFreeRecord,
  saveQnaDraft,
  startQna,
  startWithConsent,
  USE_MOCK,
  waitForAnalysis,
  type ApiResult,
} from "@/lib/api";
import { MOCK_KEYS, type MockKey } from "@/lib/api/mock/keys";
import {
  DEFAULT_MOCK_SETTINGS,
  getMockSettings,
  MOCK_SCENARIOS,
  setMockSettings,
  subscribeMockSettings,
  type MockScenario,
  type MockSettings,
} from "@/lib/api/mock/scenario";
import { clearMockSession, startMockConsentedUser } from "@/lib/api/mock/session";
import { fillMaterialBox, makeSampleSuggestion, resetDb } from "@/lib/api/mock/store";

/** 개발용: 목업 상황 고르기 + API 함수 시험 호출 (실제 서비스 메뉴에는 없음) */
export default function DevMockPage() {
  const settings = useSyncExternalStore(subscribeMockSettings, getMockSettings, () => DEFAULT_MOCK_SETTINGS);
  const [log, setLog] = useState<string>("");
  /** [제안 하나 만들기]로 만든 제안 주소 (주소창에 옮겨 적지 않고 바로 열기) */
  const [suggestionHref, setSuggestionHref] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const update = (next: MockSettings) => setMockSettings(next);

  const run = async (label: string, fn: () => Promise<ApiResult<unknown>>) => {
    setRunning(true);
    setLog(`${label} …`);
    const started = Date.now();
    try {
      const res = await fn();
      setLog(`${label} (${Date.now() - started}ms)\n${JSON.stringify(res, null, 2)}`);
    } catch (e) {
      setLog(`${label} — 예상하지 못한 오류\n${String(e)}`);
    } finally {
      setRunning(false);
    }
  };

  /** 자유 기록 저장(서버가 분석 시작) → 끝날 때까지 기다리기 (M120 흐름) */
  const analyzeFlow = () =>
    run("저장 → 분석 → 결과", async () => {
      const saved = await saveFreeRecord({
        title: "시험 기록",
        body: "오늘 아침 버스에서 오래된 친구를 우연히 만났다. 반가워서 한참 이야기했다.",
        save_token: newSaveToken(),
      });
      if (!saved.ok) return saved;
      return waitForAnalysis(saved.data.id, {
        onUpdate: (r) => setLog(`저장 → 분석 → 결과 …\n지금 상태: ${r.analysis_status}`),
      });
    });

  /** 첫 답변(active 만들기) → 임시 저장(active → draft) (W210·W211 흐름) */
  const qnaDraftFlow = () =>
    run("첫 답변 → 임시 저장", async () => {
      const questions = await getTodayQuestions();
      if (!questions.ok) return questions;
      const started = await startQna({ daily_question_id: questions.data.questions[0].id, answer: "시험 답변이에요." });
      if (!started.ok) return started;
      return saveQnaDraft(started.data.record_id);
    });

  /** 첫 답변만 (active 만들기) → H120 [AI 질문에 답하기]가 H121 없이 W210으로 가는지 확인용 */
  const qnaActiveFlow = () =>
    run("첫 답변 (진행 중 대화)", async () => {
      const questions = await getTodayQuestions();
      if (!questions.ok) return questions;
      return startQna({ daily_question_id: questions.data.questions[0].id, answer: "시험 답변이에요." });
    });

  return (
    <>
      <ScreenHeader title="목업 API (개발용)" back />
      <div className="flex flex-col gap-6 px-5 py-5">
        <p className="rounded-xl bg-subtle px-4 py-3 text-sm text-ink-soft">
          지금 모드: <b>{USE_MOCK ? "목업 (가짜 응답)" : "실제 서버"}</b>
          <br />
          실제 서버: web/.env.local 에 NEXT_PUBLIC_API_BASE_URL 을 넣어요. 배포에서 목업을 쓰려면 NEXT_PUBLIC_USE_MOCK=1.
        </p>

        <section className="flex flex-col gap-3">
          <h2 className="text-xs font-semibold text-ink-mute">기본 상황</h2>
          <ScenarioSelect
            value={settings.defaultScenario}
            onChange={(v) => update({ ...settings, defaultScenario: v as MockScenario })}
          />
          <label className="flex items-center justify-between text-sm">
            응답 기다림 (ms)
            <input
              type="number"
              min={0}
              step={100}
              value={settings.delayMs}
              onChange={(e) => update({ ...settings, delayMs: Math.max(0, Number(e.target.value) || 0) })}
              className="h-9 w-24 rounded-lg border border-line px-2 text-right"
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>
              AI 문답 이어 쓰기 기준 (초)
              <br />
              <span className="text-xs text-ink-mute">비우면 실제 값 {QNA_RESUME_WINDOW_MS / 60_000}분</span>
            </span>
            <input
              type="number"
              min={0}
              step={10}
              placeholder={String(QNA_RESUME_WINDOW_MS / 1000)}
              value={settings.qnaResumeWindowMs === null ? "" : settings.qnaResumeWindowMs / 1000}
              onChange={(e) =>
                update({
                  ...settings,
                  qnaResumeWindowMs: e.target.value === "" ? null : Math.max(0, Number(e.target.value) || 0) * 1000,
                })
              }
              className="h-9 w-24 rounded-lg border border-line px-2 text-right"
            />
          </label>
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-ink-mute">호출별 상황 (비우면 기본 상황)</h2>
            <button type="button" className="text-xs text-ink-mute underline" onClick={() => update({ ...settings, overrides: {} })}>
              모두 기본으로
            </button>
          </div>
          {(Object.keys(MOCK_KEYS) as MockKey[]).map((key) => (
            <div key={key} className="flex items-center justify-between gap-3 border-b border-line/60 py-1.5">
              <span className="text-[13px] leading-snug">{MOCK_KEYS[key]}</span>
              <ScenarioSelect
                allowEmpty
                value={settings.overrides[key] ?? ""}
                onChange={(v) => {
                  const overrides = { ...settings.overrides };
                  if (v) overrides[key] = v as MockScenario;
                  else delete overrides[key];
                  update({ ...settings, overrides });
                }}
              />
            </div>
          ))}
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold text-ink-mute">시험 호출</h2>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" disabled={running} onClick={() => run("첫 실행 동의", startWithConsent)}>
              첫 실행 동의
            </Button>
            <Button variant="secondary" disabled={running} onClick={() => run("내 정보", getMe)}>
              내 정보 (GET /me)
            </Button>
            <Button
              variant="secondary"
              disabled={running}
              onClick={() => run("세션 확인", async () => ({ ok: true, data: { has_session: await hasSession() } }))}
            >
              세션 확인
            </Button>
            <Button
              variant="secondary"
              disabled={running || !USE_MOCK}
              onClick={() => {
                fillMaterialBox();
                setLog("소재함 데이터를 채웠어요 (확인 대기 4 · 임시 저장 2 · 보관한 소재 3 · 원본만 보관 3). 기록·소재는 이 데이터로 바뀌었어요");
              }}
            >
              소재함 데이터 채우기
            </Button>
            <Button
              variant="secondary"
              disabled={running || !USE_MOCK}
              onClick={() => {
                const made = makeSampleSuggestion();
                setSuggestionHref(made ? `/new/suggestion/${made.id}` : null);
                setLog(
                  made
                    ? `제안을 만들었어요: ${made.title}. 아래 [만든 제안 열기]로 들어가 보세요`
                    : "보관한 소재가 3개 이상 있어야 해요. [소재함 데이터 채우기]를 먼저 눌러 주세요",
                );
              }}
            >
              제안 하나 만들기
            </Button>
            <Button
              variant="secondary"
              disabled={running || !USE_MOCK}
              onClick={() => {
                const session = startMockConsentedUser(new Date().toISOString());
                setLog(`동의한 사용자로 시작했어요
${JSON.stringify({ user_id: session.user_id, consented_at: session.consented_at }, null, 2)}`);
              }}
            >
              동의한 사용자로 시작
            </Button>
            <Button
              variant="secondary"
              disabled={running}
              onClick={() => {
                clearMockSession();
                setLog("목업 세션을 지웠어요 (첫 화면이면 O110)");
              }}
            >
              목업 세션 지우기
            </Button>
            <Button variant="secondary" disabled={running} onClick={() => run("홈", getHomeSummary)}>
              홈
            </Button>
            <Button variant="secondary" disabled={running} onClick={() => run("소재함", getMaterialBox)}>
              소재함
            </Button>
            <Button variant="secondary" disabled={running} onClick={() => run("자유 기록 임시 저장", getFreeDraft)}>
              자유 기록 임시 저장
            </Button>
            <Button variant="secondary" disabled={running} onClick={() => run("진행 중 문답", getActiveQna)}>
              진행 중 문답
            </Button>
            <Button variant="secondary" disabled={running} onClick={() => run("문답 임시 저장", getQnaDraft)}>
              문답 임시 저장
            </Button>
            <Button variant="secondary" disabled={running} onClick={() => run("확인 대기 분석 결과", () => getAnalysis("rec-pending-review"))}>
              분석 결과
            </Button>
            <Button variant="danger" disabled={running} onClick={() => run("모든 기록 지우기", clearAllData)}>
              모든 기록 지우기
            </Button>
          </div>
          <Button block loading={running} onClick={analyzeFlow}>
            저장 → 분석 → 결과 (M120 흐름)
          </Button>
          <Button variant="secondary" block disabled={running} onClick={qnaDraftFlow}>
            첫 답변 → 임시 저장 (W210 흐름)
          </Button>
          <Button variant="secondary" block disabled={running} onClick={qnaActiveFlow}>
            첫 답변만 (AI 진행 중 대화 만들기)
          </Button>
          <Button
            variant="ghost"
            block
            onClick={() => {
              resetDb();
              setLog("목업 데이터를 처음 상태로 되돌렸어요");
            }}
          >
            목업 데이터 처음 상태로
          </Button>
          {suggestionHref && (
            <ButtonLink href={suggestionHref} variant="secondary" block>
              만든 제안 열기 (N130)
            </ButtonLink>
          )}
          <pre className="max-h-96 overflow-auto rounded-xl bg-ink p-3 text-[11px] leading-relaxed whitespace-pre-wrap text-white">
            {log || "결과가 여기에 보여요"}
          </pre>
        </section>
      </div>
    </>
  );
}

function ScenarioSelect({ value, onChange, allowEmpty }: { value: string; onChange: (v: string) => void; allowEmpty?: boolean }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="h-9 rounded-lg border border-line bg-surface px-2 text-[13px]">
      {allowEmpty && <option value="">기본</option>}
      {(Object.keys(MOCK_SCENARIOS) as MockScenario[]).map((s) => (
        <option key={s} value={s}>
          {MOCK_SCENARIOS[s]}
        </option>
      ))}
    </select>
  );
}
