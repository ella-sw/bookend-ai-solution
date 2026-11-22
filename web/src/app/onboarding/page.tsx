"use client";

import { useId, useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  BottomActionBar,
  BottomActionBarSpacer,
  Button,
  RetryNotice,
  ScreenHeader,
} from "@/components/ui";
import { AiUsageSheet } from "@/components/common/AiUsageSheet";
import { getMe, signInWithPassword, startWithConsent } from "@/lib/api";
import { routes } from "@/lib/routes";

/**
 * O110 첫 실행 안내 · AI 사용 안내 동의 (UI 설계서 v7 O110, 목록 19번)
 * 1. 첫 화면: Rowflow 제목 + '시연 계정' 로그인(아이디·비밀번호 → [로그인], Enter로도) + [로그인 없이 시작하기]
 *    - 아이디에 "@"가 없으면 @rowflow.app을 붙인다 (signInWithPassword). 둘 다 채워야 눌림, 요청 중엔 막음
 *    - 성공 → getMe(): ok → 홈 / not_consented → 2(동의, 로그인한 계정 세션으로) / 그 밖 → 오류 문구
 *    - 오류 문구(입력칸 아래): 아이디·비번 틀림 / 연결 / 서버. 입력을 바꾸면 지움. 비밀번호는 실패해도 그대로
 *    - [로그인 없이 시작하기] → 2 (익명 시작). 회원가입·로그아웃은 없음
 * 2. 시작하기 전에: AI 사용 안내([자세히 보기] → AI 사용 안내 시트) · 기록 보관 안내 · 동의 체크 → [동의하고 시작하기]
 *    - 시트를 닫아도 동의 체크는 그대로
 *    - 동의 체크해야 눌림. 요청 중에는 버튼을 막는다 (두 번 눌러도 요청 1번)
 *    - 성공 → 홈. 실패 → '연결이 불안정해요' + [다시 시도], 이 화면에 머묾
 *    - [다시 시도]도 startWithConsent(): 이미 만든 익명 사용자(세션)를 그대로 쓴다
 */
export default function OnboardingPage() {
  // 새로 들어올 때마다 처음(서비스 소개)부터. cacheComponents는 다녀온 화면의 state를 남겨 두므로
  // key가 없으면 다시 왔을 때 '요청 중'으로 막힌 버튼·체크 상태가 남을 수 있다
  const { bfcacheId } = useRouter();
  return <Onboarding key={bfcacheId} />;
}

function Onboarding() {
  const [step, setStep] = useState<"intro" | "consent">("intro");

  return step === "intro" ? (
    <Intro onNext={() => setStep("consent")} onNeedConsent={() => setStep("consent")} />
  ) : (
    <Consent onBack={() => setStep("intro")} />
  );
}

/* ---------- 1. 서비스 소개 ---------- */

const LOGIN_ERROR: Record<"unauthorized" | "network" | "server", string> = {
  unauthorized: "아이디나 비밀번호가 맞지 않아요",
  network: "연결이 불안정해요. 다시 시도해 주세요",
  server: "지금은 로그인할 수 없어요",
};

const inputClass =
  "h-12 w-full rounded-xl border border-[#4b6031]/25 bg-[#fffdf5] px-4 text-base text-ink placeholder:text-ink-mute focus:border-[#4b6031] focus:outline-none";

function Intro({ onNext, onNeedConsent }: { onNext: () => void; onNeedConsent: () => void }) {
  const router = useRouter();
  const idFieldId = useId();
  const passwordFieldId = useId();
  const errorId = useId();
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<keyof typeof LOGIN_ERROR | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // 다시 그려지기 전의 빠른 두 번째 제출도 막는다 (Consent와 같은 방식)
  const inFlight = useRef(false);
  const submitRef = useRef<HTMLButtonElement>(null);
  const canSubmit = loginId.trim() !== "" && password !== "";

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    if (inFlight.current || !canSubmit) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const signedIn = await signInWithPassword(loginId, password);
    if (signedIn.ok) {
      const me = await getMe();
      if (me.ok) {
        router.replace(routes.home);
        return; // 이동하는 동안 버튼은 막힌 채로 둔다
      }
      if (me.error.kind === "not_consented") {
        onNeedConsent(); // 동의 단계는 지금 세션(로그인한 계정)으로 동의한다
        return;
      }
      setError(me.error.kind === "network" || me.error.kind === "timeout" ? "network" : "server");
    } else {
      setError(signedIn.reason);
    }
    setSubmitting(false);
    inFlight.current = false;
  };

  /** 키보드가 올라와도 [로그인]이 보이게 */
  const keepSubmitVisible = () => {
    window.setTimeout(() => submitRef.current?.scrollIntoView({ block: "nearest" }), 300);
  };

  const edit = (setter: (value: string) => void) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setter(event.target.value);
    setError(null);
  };

  return (
    <section className="relative isolate flex min-h-dvh flex-1 flex-col overflow-hidden bg-[#f8f3e7]">
      <Image
        src="/images/onboarding-matcha-wave.png"
        alt=""
        fill
        preload
        sizes="(max-width: 480px) 100vw, 480px"
        className="-z-10 object-cover"
      />
      <div className="flex min-h-[40dvh] flex-1 items-center justify-center px-6 py-10">
        <h1
          className="text-center text-[clamp(4rem,18vw,5.5rem)] leading-none font-normal tracking-[-0.035em] text-[#4b6031]"
          style={{ fontFamily: 'Georgia, "Noto Serif", "Times New Roman", serif' }}
        >
          Rowflow
        </h1>
      </div>

      <div className="px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <form onSubmit={login} noValidate className="flex flex-col gap-3 rounded-2xl bg-[#fffdf5]/85 p-4 backdrop-blur-sm">
          <h2 className="text-[15px] font-bold text-[#4b6031]">시연 계정</h2>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={idFieldId} className="text-sm font-semibold text-ink-soft">
              아이디
            </label>
            <input
              id={idFieldId}
              name="username"
              value={loginId}
              onChange={edit(setLoginId)}
              onFocus={keepSubmitVisible}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="예: guest"
              aria-describedby={error ? errorId : undefined}
              className={inputClass}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={passwordFieldId} className="text-sm font-semibold text-ink-soft">
              비밀번호
            </label>
            <input
              id={passwordFieldId}
              name="password"
              type="password"
              value={password}
              onChange={edit(setPassword)}
              onFocus={keepSubmitVisible}
              autoComplete="current-password"
              aria-describedby={error ? errorId : undefined}
              className={inputClass}
            />
          </div>
          <p id={errorId} aria-live="polite" className="min-h-5 text-sm text-danger">
            {error ? LOGIN_ERROR[error] : ""}
          </p>
          <button
            ref={submitRef}
            type="submit"
            disabled={!canSubmit || submitting}
            aria-busy={submitting}
            className="flex h-13 w-full scroll-mb-6 items-center justify-center rounded-xl bg-[#4b6031] px-5 text-base font-semibold text-[#fffdf5] transition-colors hover:bg-[#3d5028] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#4b6031] active:bg-[#344522] disabled:opacity-40"
          >
            {submitting ? "로그인하는 중…" : "로그인"}
          </button>
        </form>

        <button
          type="button"
          onClick={onNext}
          disabled={submitting}
          className="mt-2 flex h-11 w-full items-center justify-center rounded-xl text-[15px] font-semibold text-[#4b6031] active:bg-[#4b6031]/10 disabled:opacity-40"
        >
          로그인 없이 시작하기
        </button>
      </div>
    </section>
  );
}

/* ---------- 2. 시작하기 전에 (안내 + 동의) ---------- */

function Consent({ onBack }: { onBack: () => void }) {
  const router = useRouter();
  const checkboxId = useId();
  const [agreed, setAgreed] = useState(false);
  /** AI 사용 안내 시트. 닫아도 동의 체크(agreed)는 그대로 */
  const [aiUsageOpen, setAiUsageOpen] = useState(false);
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
          <button
            type="button"
            onClick={() => setAiUsageOpen(true)}
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

      <AiUsageSheet open={aiUsageOpen} onClose={() => setAiUsageOpen(false)} />
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
