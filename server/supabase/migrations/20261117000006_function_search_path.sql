-- Supabase에서 사용자 삭제(Authentication → Users → Delete)가
-- "Database error deleting user"로 실패하던 문제 고침.
--
-- Supabase는 사용자를 supabase_auth_admin으로 지우고, 그 계정은 search_path = auth다.
-- auth.users → users → records → materials → material_topics로 지워지면서 우리
-- 트리거 함수가 불리는데, 함수 안의 `update materials`가 auth 스키마에서 찾아져
-- "relation materials does not exist"가 났다.
--
-- public 스키마의 모든 함수가 부른 사람의 search_path와 상관없이 public을 보도록 고정한다.
-- (Supabase 보안 점검의 function_search_path_mutable 경고도 같이 해결)
-- 앞으로 함수를 새로 만들 때도 `set search_path = public, pg_temp`를 붙인다
-- (tests/test_db_rules.py::test_functions_have_fixed_search_path가 빠뜨린 함수를 잡는다).

do $$
declare
  f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' loop
    execute format('alter function %s set search_path = public, pg_temp', f);
  end loop;
end $$;
