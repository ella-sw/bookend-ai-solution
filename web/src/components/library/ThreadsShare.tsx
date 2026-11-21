"use client";

import { useState } from "react";
import { Button, useToast } from "@/components/ui";
import { splitThreadsText, threadsIntentUrl } from "@/lib/threadsShare";

const linkClass = "flex min-h-13 items-center justify-center rounded-xl border border-line px-4 py-3 text-center text-[15px] font-semibold active:bg-subtle";

/** 작성창 열기는 게시 완료가 아니므로 body_shared 이벤트를 보내지 않는다. */
export function ThreadsShare({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const toast = useToast();
  const parts = splitThreadsText(text);

  if (parts.length === 1) {
    return (
      <>
        <a href={threadsIntentUrl(text)} target="_blank" rel="noopener noreferrer" className={linkClass}>Threads에 공유</a>
        <p className="text-center text-xs text-ink-mute">Threads에서 내용을 확인한 뒤 게시해 주세요.</p>
      </>
    );
  }

  const copyPart = async (part: string) => {
    try {
      await navigator.clipboard.writeText(part);
      toast("복사했어요");
    } catch {
      toast("복사하지 못했어요");
    }
  };

  return (
    <>
      <Button block size="lg" variant="secondary" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        {expanded ? "나눠 올리기 접기" : "Threads에 공유"}
      </Button>
      {expanded && (
        <div className="flex max-h-[50dvh] flex-col gap-4 overflow-y-auto py-2" aria-label="Threads에 나눠 올리기">
          <p className="text-sm leading-relaxed text-ink-soft">
            긴 글을 {parts.length}개로 나눴어요. 첫 부분을 게시한 뒤, 나머지는 복사해서 Threads의 답글로 이어 붙여 주세요.
          </p>
          {parts.map((part, index) => (
            <section key={index} className="flex flex-col gap-3 rounded-xl bg-subtle p-4">
              <h3 className="text-sm font-bold">{index + 1} / {parts.length}</h3>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{part}</p>
              {index === 0 ? (
                <a href={threadsIntentUrl(part)} target="_blank" rel="noopener noreferrer" className={linkClass}>첫 부분을 Threads에 공유</a>
              ) : (
                <Button block variant="secondary" onClick={() => void copyPart(part)}>이어서 올릴 내용 복사</Button>
              )}
            </section>
          ))}
        </div>
      )}
    </>
  );
}
