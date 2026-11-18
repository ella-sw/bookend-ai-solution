import { Suspense } from "react";
import QnaChatScreen from "@/components/collect/QnaChat";
import { Loading } from "@/components/ui";

/**
 * W210 AI 질문에 답하기 (+ W211 나가기 확인, W212 질문 마무리)
 * ?resume=active|draft를 읽으므로 Suspense로 감싼다 (cacheComponents: 주소 검색값은 요청 때 정해짐)
 */
export default function CollectAiPage() {
  return (
    <Suspense fallback={<Loading fullScreen />}>
      <QnaChatScreen />
    </Suspense>
  );
}
