-- 실제 Supabase에서 서버 요청이 500 (permission denied for schema auth)이 나던 문제 고침.
--
-- 0001의 `grant usage on schema auth to app_user`는 Supabase에서 아무 일도 하지 않았다.
-- auth 스키마의 주인은 supabase_admin이고, postgres는 그 권한을 남에게 줄 수 없다
-- (경고만 나고 넘어감). 그래서 app_user가 auth.uid()를 부를 수 없었다.
--
-- 대신 app_user가 Supabase의 authenticated 역할 권한을 물려받게 한다. authenticated는
-- auth 스키마 사용과 auth.uid() 실행 권한이 있다. 우리 테이블·함수 권한은 0001·0004에서
-- authenticated에게서 모두 뺐으므로, 이걸로 브라우저가 얻는 권한은 없다
-- (방향: app_user가 authenticated의 권한을 받는 것이지, 그 반대가 아님).

grant authenticated to app_user;

-- 0001의 직접 권한은 Supabase에는 없으므로, 테스트 DB에서도 빼서 두 환경을 똑같이 맞춘다.
revoke usage on schema auth from app_user;
