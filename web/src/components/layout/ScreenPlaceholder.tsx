import Link from "next/link";
import { ScreenHeader } from "@/components/ui/ScreenHeader";

/**
 * 0단계용 빈 화면. 화면 ID·이름과 할 일, 이동할 화면 링크만 보여 준다.
 * 각 화면을 실제로 만들 때 이 컴포넌트를 지우고 바꾼다.
 */
export default function ScreenPlaceholder({
  id,
  title,
  back = true,
  notes = [],
  links = [],
  param,
}: {
  id: string;
  title: string;
  back?: boolean;
  notes?: string[];
  links?: { label: string; href: string }[];
  param?: { name: string; value: string };
}) {
  return (
    <>
      <ScreenHeader title={title} back={back} />
      <section className="flex flex-1 flex-col gap-5 px-5 py-6">
        <div>
          <span className="inline-flex rounded-md bg-accent-soft px-2 py-1 font-mono text-xs font-semibold text-[#843c0c]">
            {id} · 준비 중
          </span>
          {param && (
            <p className="mt-2 font-mono text-xs text-ink-mute">
              {param.name} = {param.value}
            </p>
          )}
        </div>
        {notes.length > 0 && (
          <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-ink-soft">
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
        {links.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold text-ink-mute">이동 화면</p>
            {links.map((link) => (
              <Link
                key={link.href + link.label}
                href={link.href}
                className="flex h-12 items-center justify-between rounded-xl border border-line px-4 text-[15px] active:bg-subtle"
              >
                {link.label}
                <span aria-hidden className="text-ink-mute">
                  ›
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
