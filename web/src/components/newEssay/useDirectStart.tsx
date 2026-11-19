"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog, useToast } from "@/components/ui";
import { getEssayDraft, type IsoTime } from "@/lib/api";
import { resumeDialogCopy } from "@/lib/collectEntry";
import { newEssayHref, type NewEssayParams } from "@/lib/newEssayParams";
import { routes } from "@/lib/routes";
import { useOnboardingRedirect } from "@/lib/useOnboardingRedirect";

/**
 * 직접 쓰기(N140)로 들어가기 전 이어 쓰기 확인 (H121). N110 [소재 없이 직접 쓰기]·N120 [직접 쓰기]가 쓴다.
 * - 직접 쓰기 임시 저장이 있으면 '임시 저장한 글이 있어요 (11.19)' (목록 17번)
 *   [이어 쓰기] → N140 ?resume=draft (임시 저장의 소재·방향·제안을 씀, 지금 고른 값은 쓰지 않음)
 *   [새로 시작] → N140 새로 (임시 저장은 남고, 새로 임시 저장하면 덮어씀)
 * - 없으면 바로 N140. 확인이 실패하면 '연결이 불안정해요' 토스트, 머묾 (임시 저장을 덮어쓰지 않게)
 */
export function useDirectStart() {
  const router = useRouter();
  const toast = useToast();
  const goOnboardingIfNeeded = useOnboardingRedirect();
  const [checking, setChecking] = useState(false);
  const [confirm, setConfirm] = useState<{ fresh: string; resume: string; updatedAt: IsoTime } | null>(null);
  const busy = useRef(false);

  const start = async (params: NewEssayParams) => {
    if (busy.current) return;
    busy.current = true;
    setChecking(true);
    const res = await getEssayDraft();
    busy.current = false;
    setChecking(false);
    if (!res.ok) {
      if (!goOnboardingIfNeeded(res.error)) toast("연결이 불안정해요");
      return;
    }
    const fresh = newEssayHref(routes.newDirect, params);
    if (!res.data) {
      router.push(fresh);
      return;
    }
    // 이어 쓰기는 임시 저장의 값을 쓰고, 들어온 경로(from)·흐름 id(f)만 넘긴다 (writing_started, 목록 7번)
    const resume = newEssayHref(routes.newDirect, { from: params.from, f: params.f, resume: "draft" });
    setConfirm({ fresh, resume, updatedAt: res.data.updated_at });
  };

  const copy = resumeDialogCopy("essay", confirm?.updatedAt ?? null);
  const dialog = (
    <ConfirmDialog
      open={confirm !== null}
      onClose={() => setConfirm(null)}
      title={copy.title}
      description={copy.description}
      actions={
        confirm
          ? [
              { label: copy.freshLabel, navigateTo: confirm.fresh },
              { label: copy.resumeLabel, variant: "primary", navigateTo: confirm.resume },
            ]
          : []
      }
    />
  );

  return { start, checking, dialog };
}
