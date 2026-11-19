"use client";

import { useEffect } from "react";
import { installNavDirection } from "@/lib/navDirection";

/** 뒤로/앞으로 가기 감지를 1번 설치한다 (lib/navDirection.ts). 화면에는 아무것도 그리지 않음 */
export default function NavDirectionListener() {
  useEffect(() => {
    installNavDirection();
  }, []);
  return null;
}
