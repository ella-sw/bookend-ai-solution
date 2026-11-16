"use client";

import { useState } from "react";
import {
  BottomSheet,
  Button,
  Chip,
  ChipRow,
  ConfirmDialog,
  Loading,
  MaterialCard,
  RetryNotice,
  ScreenHeader,
  useToast,
} from "@/components/ui";

/**
 * 개발용: 공통 부품 미리보기 (실제 서비스 메뉴에는 없음).
 * 아래 예시 글은 부품 모양 확인용 문구일 뿐, 화면 데이터가 아니다.
 */
export default function DevComponentsPage() {
  const toast = useToast();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [dialog, setDialog] = useState<"two" | "three" | null>(null);
  const [topic, setTopic] = useState("전체");
  const [busy, setBusy] = useState(false);

  const fakeRequest = () => {
    setBusy(true);
    setTimeout(() => setBusy(false), 1500);
  };

  return (
    <>
      <ScreenHeader title="공통 부품 (개발용)" back />
      <div className="flex flex-col gap-8 px-5 py-6">
        <Section title="버튼">
          <div className="flex flex-wrap gap-2">
            <Button>기본</Button>
            <Button variant="secondary">보조</Button>
            <Button variant="ghost">약하게</Button>
            <Button variant="danger">지우기</Button>
            <Button disabled>막힘</Button>
            <Button loading={busy} onClick={fakeRequest}>
              요청 중 막기
            </Button>
          </div>
          <Button size="lg" block>
            크게 · 꽉 차게
          </Button>
        </Section>

        <Section title="칩">
          <ChipRow>
            {["전체", "가족", "일상", "일", "여행", "관계", "건강"].map((t) => (
              <Chip key={t} selected={topic === t} onClick={() => setTopic(t)}>
                {t}
              </Chip>
            ))}
          </ChipRow>
        </Section>

        <Section title="소재 카드 (상태별)">
          <MaterialCard title="보관한 소재 예시" summary="요약 두 줄까지 보여요." topics={["가족"]} date="11.12" usedCount={2} />
          <MaterialCard title="확인 대기 예시" status="review" />
          <MaterialCard title="분석 중 예시" status="analyzing" />
          <MaterialCard title="소재 없음 예시" status="empty" />
          <MaterialCard title="분석 실패 예시" status="failed" />
          <MaterialCard title="임시 저장 예시" status="draft" />
          <MaterialCard title="원본만 보관 예시" status="rawOnly" />
          <MaterialCard title="고른 상태 (N110)" topics={["일상"]} selected />
        </Section>

        <Section title="실패 + 다시 시도">
          <RetryNotice message="연결이 불안정해요" retrying={busy} onRetry={fakeRequest} />
        </Section>

        <Section title="로딩">
          <Loading message="기록에서 소재를 찾고 있어요" />
        </Section>

        <Section title="팝업 · 시트 · 토스트">
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setDialog("two")}>
              확인 팝업 (버튼 2개)
            </Button>
            <Button variant="secondary" onClick={() => setDialog("three")}>
              확인 팝업 (버튼 3개)
            </Button>
            <Button variant="secondary" onClick={() => setSheetOpen(true)}>
              아래 시트
            </Button>
            <Button variant="secondary" onClick={() => toast("복사했어요")}>
              토스트
            </Button>
          </div>
        </Section>
      </div>

      <ConfirmDialog
        open={dialog === "two"}
        onClose={() => setDialog(null)}
        title="모든 기록을 지울까요?"
        description="소재·글·대화·임시 저장이 모두 지워지고 되돌릴 수 없어요."
        actions={[
          { label: "취소", onClick: () => {} },
          { label: "지우기", variant: "danger", onClick: () => toast("지우기 누름") },
        ]}
      />
      <ConfirmDialog
        open={dialog === "three"}
        onClose={() => setDialog(null)}
        title="작성 중인 내용이 있어요"
        description="임시 저장하지 않은 내용은 사라져요."
        actions={[
          { label: "임시 저장하고 나가기", variant: "primary", onClick: () => toast("임시 저장하고 나가기") },
          { label: "저장하지 않고 나가기", onClick: () => toast("저장하지 않고 나가기") },
          { label: "계속 쓰기", variant: "ghost", onClick: () => {} },
        ]}
      />
      <BottomSheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="아래 시트 예시">
        <p className="pb-2 text-sm text-ink-soft">뒤로가기를 누르면 시트가 먼저 닫혀요.</p>
      </BottomSheet>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xs font-semibold text-ink-mute">{title}</h2>
      {children}
    </section>
  );
}
