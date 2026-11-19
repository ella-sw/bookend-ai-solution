import type { Metadata, Viewport } from "next";
import AppShell from "@/components/layout/AppShell";
import NavDirectionListener from "@/components/layout/NavDirectionListener";
import "./globals.css";

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
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko" className="h-full antialiased">
      <body className="min-h-full">
        <NavDirectionListener />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
