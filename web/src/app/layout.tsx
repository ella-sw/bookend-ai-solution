import type { Metadata, Viewport } from "next";
import { Noto_Serif_KR } from "next/font/google";
import AppShell from "@/components/layout/AppShell";
import "./globals.css";

// 제목용 명조 (Figma 시안). 한글 글꼴이 커서 미리 불러오지 않고, 필요한 글자만 받는다.
const serif = Noto_Serif_KR({
  weight: ["400", "600"],
  subsets: ["latin"],
  display: "swap",
  preload: false,
  variable: "--font-noto-serif-kr",
});

export const metadata: Metadata = {
  title: "Rowflow",
  description: "소재를 모으고, 모인 소재로 에세이를 써요",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Android Chrome: 키보드가 올라오면 화면 높이를 줄여 아래 고정 버튼이 키보드 위에 오게 함
  // (iOS Safari는 이 값을 무시 → KeyboardInset이 --keyboard-inset으로 보정)
  interactiveWidget: "resizes-content",
  themeColor: "#f7f6f1",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko" className={`h-full antialiased ${serif.variable}`}>
      <body className="min-h-full">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
