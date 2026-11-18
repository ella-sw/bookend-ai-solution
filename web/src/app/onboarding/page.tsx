"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BottomActionBar,
  BottomActionBarSpacer,
  Button,
  RetryNotice,
  ScreenHeader,
  useToast,
} from "@/components/ui";
import { startWithConsent } from "@/lib/api";
import { routes } from "@/lib/routes";

/**
 * O110 첫 실행 안내 · AI 사용 안내 동의 (UI 설계서 v7 O110, 목록 19번)
 * 1. 서비스 소개 → [다음]
 * 2. 시작하기 전에: AI 사용 안내([자세히 보기]) · 기록 보관 안내 · 동의 체크 → [동의하고 시작하기]
 *    - 동의 체크해야 눌림. 요청 중에는 버튼을 막는다 (두 번 눌러도 요청 1번)
 *    - 성공 → 홈. 실패 → '연결이 불안정해요' + [다시 시도], 이 화면에 머묾
 *    - [다시 시도]도 startWithConsent(): 이미 만든 익명 사용자(세션)를 그대로 쓴다
 */
export default function OnboardingPage() {
  const [step, setStep] = useState<"intro" | "consent">("intro");

  return step === "intro" ? <Intro onNext={() => setStep("consent")} /> : <Consent onBack={() => setStep("intro")} />;
}

/* ---------- 1. 서비스 소개 ---------- */

function Intro({ onNext }: { onNext: () => void }) {
  return (
    <>
      <section className="flex flex-1 flex-col justify-center px-6 py-10">
        <h1 className="text-3xl font-extrabold tracking-tight">Rowflow</h1>
        <p className="mt-2 text-[15px] text-ink-soft">소재를 모으고, 모인 소재로 글을 써요</p>

        <ol className="mt-10 flex flex-col gap-4">
          <IntroStep no={1} title="소재 모으기" description="떠오른 경험을 적거나 AI 질문에 답해요" />
          <IntroStep no={2} title="새 글 쓰기" description="모인 소재를 골라 글로 엮어요" />
        </ol>
      </section>

      <BottomActionBarSpacer />
      <BottomActionBar>
        <Button block size="lg" onClick={onNext}>
          다음
        </Button>
      </BottomActionBar>
    </>
  );
}

function IntroStep({ no, title, description }: { no: number; title: string; description: string }) {
  return (
    <li className="flex items-start gap-4 rounded-2xl bg-subtle p-4">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-white">
        {no}
      </span>
      <span>
        <span className="block text-base font-bold">{title}</span>
        <span className="text-sm text-ink-soft">{description}</span>
      </span>
    </li>
  );
}

/* ---------- 2. 시작하기 전에 (안내 + 동의) ---------- */

function Consent({ onBack }: { onBack: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const checkboxId = useId();
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  // 다시 그려지기 전의 빠른 두 번째 클릭도 막는다
  const inFlight = useRef(false);

  const submit = async () => {
    if (inFlight.current || !agreed) return;
    inFlight.current = true;
    setSubmitting(true);
    const res = await startWithConsent();
    if (res.ok) {
      router.replace(routes.home);
      return; // 이동하는 동안 버튼은 막힌 채로 둔다
    }
    setFailed(true);
    setSubmitting(false);
    inFlight.current = false;
  };

  return (
    <>
      <ScreenHeader title="시작하기 전에" back onBack={onBack} />

      <div className="flex flex-col gap-4 px-5 pt-5">
        <Notice title="AI 사용 안내">
          <p>AI가 기록을 분석하고 글을 다듬기 위해 외부 AI 회사로 기록이 전달돼요.</p>
          {/* 개인정보 처리방침 화면은 아직 없음 (설정 S110과 같게 '준비 중') */}
          <button
            type="button"
            onClick={() => toast("준비 중이에요")}
            className="mt-2 text-sm font-semibold text-primary active:opacity-70"
          >
            자세히 보기 ›
          </button>
        </Notice>

        <Notice title="기록 보관 안내">
          <p>
            이 브라우저로 내 기록을 찾아요. 브라우저 데이터를 지우면 다시 들어올 수 없고, 1달 동안 접속하지 않으면 기록이
            정리돼요.
          </p>
        </Notice>

        <label
          htmlFor={checkboxId}
          className="flex cursor-pointer items-center gap-3 rounded-2xl border border-line px-4 py-4 active:bg-subtle"
        >
          <input
            id={checkboxId}
            type="checkbox"
            checked={agreed}
            disabled={submitting}
            onChange={(e) => setAgreed(e.target.checked)}
            className="size-5 shrink-0 accent-primary"
          />
          <span className="text-[15px] font-semibold">위 내용을 확인했고 동의해요</span>
        </label>

        {failed && <RetryNotice message="연결이 불안정해요" onRetry={submit} retrying={submitting} />}
      </div>

      <BottomActionBarSpacer />
      <BottomActionBar>
        <Button block size="lg" disabled={!agreed} loading={submitting} onClick={submit}>
          동의하고 시작하기
        </Button>
      </BottomActionBar>
    </>
  );
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-subtle p-4">
      <h2 className="text-[15px] font-bold">{title}</h2>
      <div className="mt-1.5 text-sm leading-relaxed text-ink-soft">{children}</div>
    </section>
  );
}
