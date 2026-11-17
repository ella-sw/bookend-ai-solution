import { Button } from "./Button";

/**
 * 실패 안내 + [다시 시도]. 화면을 떠나지 않고 그 자리에서 다시 시도한다.
 * 예) O110 '연결이 불안정해요', W110 저장 실패(입력은 그대로), S120 '지우지 못했어요'
 * - retrying: 다시 시도 요청 중이면 버튼을 막는다
 */
export function RetryNotice({
  message,
  onRetry,
  retrying = false,
  retryLabel = "다시 시도",
}: {
  message: string;
  onRetry: () => void;
  retrying?: boolean;
  retryLabel?: string;
}) {
  return (
    <div role="alert" className="flex items-center justify-between gap-3 rounded-xl bg-subtle px-4 py-3">
      <p className="text-sm text-ink-soft">{message}</p>
      <Button variant="secondary" className="h-9 shrink-0 px-3 text-sm" loading={retrying} onClick={onRetry}>
        {retryLabel}
      </Button>
    </div>
  );
}
