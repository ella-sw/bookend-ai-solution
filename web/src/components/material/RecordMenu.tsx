"use client";

import { useRef } from "react";
import { BottomSheet, ConfirmDialog } from "@/components/ui";
import type { ApiError } from "@/lib/api";

/** 더보기 시트의 한 줄 (M131 더보기·기록 메뉴) */
export function SheetItem({ label, onClick, danger, disabled }: { label: string; onClick: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex h-13 items-center rounded-xl px-1 text-left text-[15px] active:bg-subtle disabled:opacity-40 ${danger ? "text-danger" : "text-ink"}`}
    >
      {label}
    </button>
  );
}

/**
 * 기록 메뉴 (목록 1·2번): M120 done·failed 헤더 [더보기], M110 확인 대기 카드 [⋯]
 * [기록 지우기]를 고르면 시트가 다 닫힌 뒤 onDelete (다른 팝업이 뒤로가기 기록과 엉키지 않게)
 */
export function RecordMenuSheet({ open, onClose, onDelete }: { open: boolean; onClose: () => void; onDelete: () => void }) {
  const chosen = useRef(false);
  return (
    <BottomSheet
      open={open}
      title="기록 메뉴"
      onClose={() => {
        onClose();
        if (chosen.current) {
          chosen.current = false;
          onDelete();
        }
      }}
    >
      {({ close }) => (
        <div className="flex flex-col">
          <SheetItem
            label="기록 지우기"
            danger
            onClick={() => {
              chosen.current = true;
              close();
            }}
          />
        </div>
      )}
    </BottomSheet>
  );
}

/** 기록 지우기 확인 (M120·M110 같이 씀). [지우기]를 고르면 팝업이 다 닫힌 뒤 onConfirm */
export function RecordDeleteDialog({ open, onClose, onConfirm }: { open: boolean; onClose: () => void; onConfirm: () => void }) {
  const chosen = useRef(false);
  return (
    <ConfirmDialog
      open={open}
      onClose={() => {
        onClose();
        if (chosen.current) {
          chosen.current = false;
          onConfirm();
        }
      }}
      title="이 기록을 지울까요?"
      description="지운 기록은 되돌릴 수 없어요."
      actions={[
        { label: "취소", onClick: () => (chosen.current = false) },
        { label: "지우기", variant: "danger", onClick: () => (chosen.current = true) },
      ]}
    />
  );
}

/** 기록 지우기 실패 문구 (보관한 소재가 있거나 지운 소재의 원본이면 서버가 막음, 목록 22번) */
export function recordDeleteFailMessage(error: ApiError): string {
  if (error.code === "material_confirmed" || error.code === "material_deleted") return "이 기록은 지울 수 없어요";
  if (error.code === "record_not_found") return "기록을 찾을 수 없어요";
  return "지우지 못했어요";
}
