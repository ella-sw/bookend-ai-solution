import type { NextConfig } from "next";

// 배포 빌드에서 서버 주소도, 목업 사용 표시도 없으면 멈춘다.
// (빠뜨린 채 배포되면 실제 사이트가 가짜 데이터로 돌기 때문. src/lib/api/config.ts 참고)
// 로컬에서 빌드만 확인할 때: NEXT_PUBLIC_USE_MOCK=1 npm run build
if (
  process.env.NODE_ENV === "production" &&
  !process.env.NEXT_PUBLIC_API_BASE_URL &&
  process.env.NEXT_PUBLIC_USE_MOCK !== "1"
) {
  throw new Error(
    "NEXT_PUBLIC_API_BASE_URL(실제 서버 주소) 또는 NEXT_PUBLIC_USE_MOCK=1(목업) 중 하나를 환경 변수에 넣어 주세요.",
  );
}

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
